package online.optiprotrade.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.os.Build;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

public class SecureTokenStore {
    private static final String KEY_ALIAS="OptiTradeTrustedDeviceKey";
    private static final String PREFS="optitrade_secure";
    private final SharedPreferences prefs;
    public SecureTokenStore(Context c){ prefs=c.getSharedPreferences(PREFS,Context.MODE_PRIVATE); }
    private SecretKey key() throws Exception {
        KeyStore ks=KeyStore.getInstance("AndroidKeyStore");ks.load(null);
        if(ks.containsAlias(KEY_ALIAS)) return ((KeyStore.SecretKeyEntry)ks.getEntry(KEY_ALIAS,null)).getSecretKey();
        KeyGenerator kg=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");
        KeyGenParameterSpec.Builder b=new KeyGenParameterSpec.Builder(KEY_ALIAS,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setUserAuthenticationRequired(true);
        if(Build.VERSION.SDK_INT>=30) b.setUserAuthenticationParameters(30,KeyProperties.AUTH_BIOMETRIC_STRONG|KeyProperties.AUTH_DEVICE_CREDENTIAL);
        else b.setUserAuthenticationValidityDurationSeconds(30);
        kg.init(b.build());
        return kg.generateKey();
    }
    public boolean hasToken(){ return prefs.contains("token_ct") && prefs.contains("token_iv"); }
    public void save(String token) throws Exception {
        Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.ENCRYPT_MODE,key());
        byte[] ct=c.doFinal(token.getBytes(StandardCharsets.UTF_8));
        prefs.edit().putString("token_ct",Base64.encodeToString(ct,Base64.NO_WRAP)).putString("token_iv",Base64.encodeToString(c.getIV(),Base64.NO_WRAP)).apply();
    }
    public String load() throws Exception {
        String ct=prefs.getString("token_ct",null),iv=prefs.getString("token_iv",null);if(ct==null||iv==null)return null;
        Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(iv,Base64.NO_WRAP)));
        return new String(c.doFinal(Base64.decode(ct,Base64.NO_WRAP)),StandardCharsets.UTF_8);
    }
    public void clear(){ prefs.edit().remove("token_ct").remove("token_iv").apply(); }
}