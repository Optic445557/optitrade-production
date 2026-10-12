package online.optiprotrade.app;

import android.app.AlertDialog;
import android.app.DownloadManager;
import android.app.KeyguardManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.os.Build;
import android.provider.Settings;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.ProgressBar;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AppCompatActivity;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;

import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Executor;

public class MainActivity extends AppCompatActivity {
    private static final String BASE="https://optiprotrade.online";
    private static final String HOME=BASE+"/";
    private static final String HOST="optiprotrade.online";
    private WebView webView; private ProgressBar progress; private View offlinePanel; private ValueCallback<Uri[]> fileCallback;
    private SecureTokenStore tokenStore; private SharedPreferences prefs; private boolean dashboardSeen=false; private boolean enrollmentPromptShown=false;

    private final ActivityResultLauncher<Intent> filePicker=registerForActivityResult(new ActivityResultContracts.StartActivityForResult(),result->{Uri[] out=null;if(result.getResultCode()==RESULT_OK&&result.getData()!=null&&result.getData().getData()!=null)out=new Uri[]{result.getData().getData()};if(fileCallback!=null){fileCallback.onReceiveValue(out);fileCallback=null;}});

    @Override protected void onCreate(Bundle savedInstanceState){
        super.onCreate(savedInstanceState);setContentView(R.layout.activity_main);
        tokenStore=new SecureTokenStore(this);prefs=getSharedPreferences("optitrade_app",MODE_PRIVATE);
        webView=findViewById(R.id.webView);progress=findViewById(R.id.progress);offlinePanel=findViewById(R.id.offlinePanel);Button retry=findViewById(R.id.retryButton);
        configureWebView();retry.setOnClickListener(v->startEntry());
        if(savedInstanceState!=null){webView.restoreState(savedInstanceState);return;}
        startEntry();
    }

    private void startEntry(){
        if(tokenStore.hasToken() && biometricAvailable()) promptBiometricAndTrustedLogin();
        else loadInitialUrl();
    }
    private boolean biometricAvailable(){
        BiometricManager bm=BiometricManager.from(this);
        if(Build.VERSION.SDK_INT>=30){int allowed=BiometricManager.Authenticators.BIOMETRIC_STRONG|BiometricManager.Authenticators.DEVICE_CREDENTIAL;return bm.canAuthenticate(allowed)==BiometricManager.BIOMETRIC_SUCCESS;}
        KeyguardManager km=(KeyguardManager)getSystemService(KEYGUARD_SERVICE);
        return bm.canAuthenticate()==BiometricManager.BIOMETRIC_SUCCESS || (km!=null && km.isDeviceSecure());
    }
    private BiometricPrompt.PromptInfo phoneSecurityPrompt(String title,String subtitle){
        BiometricPrompt.PromptInfo.Builder b=new BiometricPrompt.PromptInfo.Builder().setTitle(title).setSubtitle(subtitle);
        if(Build.VERSION.SDK_INT>=30)b.setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG|BiometricManager.Authenticators.DEVICE_CREDENTIAL);
        else b.setDeviceCredentialAllowed(true);
        return b.build();
    }
    private void promptBiometricAndTrustedLogin(){
        Executor ex=ContextCompat.getMainExecutor(this);BiometricPrompt bp=new BiometricPrompt(this,ex,new BiometricPrompt.AuthenticationCallback(){
            @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult r){super.onAuthenticationSucceeded(r);trustedLogin();}
            @Override public void onAuthenticationError(int code,CharSequence msg){super.onAuthenticationError(code,msg);loadInitialUrl();}
        });
        bp.authenticate(phoneSecurityPrompt("Unlock OptiTrade","Use your fingerprint, face or phone screen lock"));
    }
    private void trustedLogin(){
        new Thread(()->{try{String token=tokenStore.load();if(token==null)throw new Exception("missing token");JSONObject body=new JSONObject().put("token",token);HttpURLConnection c=open("/api/auth/trusted-device/login","POST");writeJson(c,body);int status=c.getResponseCode();String response=read(c,status<400);if(status>=200&&status<300){captureCookies(c);runOnUiThread(()->webView.loadUrl(BASE+"/dashboard.html"));}else{tokenStore.clear();runOnUiThread(()->{new AlertDialog.Builder(this).setTitle("Sign in again").setMessage("This trusted-device sign-in is no longer valid. Sign in once with your password and email code, then you can remember this device again.").setPositiveButton("Continue",(d,w)->loadInitialUrl()).show();});}}catch(Exception e){runOnUiThread(this::loadInitialUrl);}}).start();
    }
    private void maybeOfferEnrollment(){
        if(enrollmentPromptShown||tokenStore.hasToken()||!biometricAvailable())return;enrollmentPromptShown=true;
        new AlertDialog.Builder(this).setTitle("Remember this device?").setMessage("Next time, unlock OptiTrade with your fingerprint, face or phone screen lock instead of requesting an email login code. Your password and OTP are not stored.").setPositiveButton("Remember device",(d,w)->confirmEnrollmentWithPhoneSecurity()).setNegativeButton("Not now",null).show();
    }
    private void confirmEnrollmentWithPhoneSecurity(){
        Executor ex=ContextCompat.getMainExecutor(this);BiometricPrompt bp=new BiometricPrompt(this,ex,new BiometricPrompt.AuthenticationCallback(){
            @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult r){super.onAuthenticationSucceeded(r);enrollTrustedDevice();}
        });
        bp.authenticate(phoneSecurityPrompt("Enable trusted-device sign-in","Confirm with your phone security"));
    }
    private void enrollTrustedDevice(){
        new Thread(()->{try{String cookie=CookieManager.getInstance().getCookie(BASE);if(cookie==null||!cookie.contains("ot_session="))return;String installationId=prefs.getString("installation_id",null);if(installationId==null){installationId=UUID.randomUUID().toString();prefs.edit().putString("installation_id",installationId).apply();}String label=android.os.Build.MANUFACTURER+" "+android.os.Build.MODEL;JSONObject body=new JSONObject().put("installationId",installationId).put("label",label);HttpURLConnection c=open("/api/auth/trusted-device/enroll","POST");c.setRequestProperty("Cookie",cookie);writeJson(c,body);int status=c.getResponseCode();String response=read(c,status<400);if(status>=200&&status<300){String token=new JSONObject(response).getString("token");tokenStore.save(token);runOnUiThread(()->new AlertDialog.Builder(this).setTitle("Device remembered").setMessage("Phone-security sign-in is now enabled for this OptiTrade app.").setPositiveButton("OK",null).show());}}catch(Exception ignored){}}).start();
    }
    private void revokeAndClearLocalTrustedDevice(){
        new Thread(()->{try{String token=tokenStore.load();if(token!=null){HttpURLConnection c=open("/api/auth/trusted-device/revoke-token","POST");writeJson(c,new JSONObject().put("token",token));c.getResponseCode();}}catch(Exception ignored){}finally{tokenStore.clear();}}).start();
    }
    private void configureWebView(){
        WebSettings s=webView.getSettings();s.setJavaScriptEnabled(true);s.setDomStorageEnabled(true);s.setDatabaseEnabled(true);s.setAllowFileAccess(false);s.setAllowContentAccess(true);s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);s.setUserAgentString(s.getUserAgentString()+" OptiTradeAndroid/1.0");
        CookieManager cm=CookieManager.getInstance();cm.setAcceptCookie(true);cm.setAcceptThirdPartyCookies(webView,false);
        webView.setWebChromeClient(new WebChromeClient(){@Override public void onProgressChanged(WebView v,int p){progress.setProgress(p);progress.setVisibility(p>=100?View.GONE:View.VISIBLE);}@Override public boolean onShowFileChooser(WebView v,ValueCallback<Uri[]> cb,FileChooserParams params){if(fileCallback!=null)fileCallback.onReceiveValue(null);fileCallback=cb;try{filePicker.launch(params.createIntent());return true;}catch(Exception e){fileCallback=null;return false;}}});
        webView.setWebViewClient(new WebViewClient(){
            @Override public boolean shouldOverrideUrlLoading(WebView v,WebResourceRequest r){Uri u=r.getUrl();String scheme=u.getScheme()==null?"":u.getScheme(),host=u.getHost()==null?"":u.getHost();if("https".equalsIgnoreCase(scheme)&&(HOST.equalsIgnoreCase(host)||host.endsWith("."+HOST)))return false;try{startActivity(new Intent(Intent.ACTION_VIEW,u));}catch(Exception ignored){}return true;}
            @Override public void onPageFinished(WebView v,String url){offlinePanel.setVisibility(View.GONE);webView.setVisibility(View.VISIBLE);if(url!=null&&url.contains("/dashboard.html")){dashboardSeen=true;maybeOfferEnrollment();}else if(dashboardSeen&&url!=null&&url.contains("/login.html")){dashboardSeen=false;revokeAndClearLocalTrustedDevice();}}
            @Override public void onReceivedError(WebView v,WebResourceRequest r,WebResourceError e){if(r.isForMainFrame()){webView.setVisibility(View.GONE);offlinePanel.setVisibility(View.VISIBLE);}}
        });
        webView.setDownloadListener((url,ua,cd,mime,len)->{DownloadManager.Request req=new DownloadManager.Request(Uri.parse(url));req.setMimeType(mime);req.addRequestHeader("User-Agent",ua);String cookie=CookieManager.getInstance().getCookie(url);if(cookie!=null)req.addRequestHeader("Cookie",cookie);req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS,"OptiTrade-download");((DownloadManager)getSystemService(DOWNLOAD_SERVICE)).enqueue(req);});
    }
    private void loadInitialUrl(){Uri dl=getIntent().getData();if(dl!=null&&"https".equalsIgnoreCase(dl.getScheme())&&HOST.equalsIgnoreCase(dl.getHost()))webView.loadUrl(dl.toString());else webView.loadUrl(HOME);}
    private HttpURLConnection open(String path,String method)throws Exception{HttpURLConnection c=(HttpURLConnection)new URL(BASE+path).openConnection();c.setRequestMethod(method);c.setConnectTimeout(12000);c.setReadTimeout(12000);c.setRequestProperty("Content-Type","application/json");c.setRequestProperty("Accept","application/json");c.setRequestProperty("X-OptiTrade-Client","android-native-1.0");c.setDoInput(true);return c;}
    private void writeJson(HttpURLConnection c,JSONObject body)throws Exception{c.setDoOutput(true);try(OutputStream os=c.getOutputStream()){os.write(body.toString().getBytes(StandardCharsets.UTF_8));}}
    private String read(HttpURLConnection c,boolean success)throws Exception{InputStream in=success?c.getInputStream():c.getErrorStream();if(in==null)return "";StringBuilder b=new StringBuilder();try(BufferedReader r=new BufferedReader(new InputStreamReader(in,StandardCharsets.UTF_8))){String line;while((line=r.readLine())!=null)b.append(line);}return b.toString();}
    private void captureCookies(HttpURLConnection c){Map<String,List<String>> h=c.getHeaderFields();for(Map.Entry<String,List<String>> e:h.entrySet()){if(e.getKey()!=null&&"Set-Cookie".equalsIgnoreCase(e.getKey()))for(String cookie:e.getValue())CookieManager.getInstance().setCookie(BASE,cookie);}CookieManager.getInstance().flush();}
    @Override protected void onSaveInstanceState(Bundle out){webView.saveState(out);super.onSaveInstanceState(out);}
    @Override public void onBackPressed(){if(webView.canGoBack())webView.goBack();else super.onBackPressed();}
}