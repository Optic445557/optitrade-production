# OptiTrade Android App 1.0

Official host: https://optiprotrade.online
Package: `online.optiprotrade.app`

## Trusted-device flow
1. First login still uses password + email OTP.
2. After the verified customer dashboard opens, the app asks **Remember this device?**.
3. The server issues a random 90-day device token. The server stores only its SHA-256 hash.
4. Android encrypts the token with a key held in Android Keystore.
5. Future app launches require fingerprint, face unlock or device credential before the token is used.
6. Password reset/change revokes all trusted-device tokens.
7. Users can revoke one or all devices from Security -> Trusted Devices.

The app never stores the user's password or OTP.

## Build
Open this `android-app` folder in Android Studio. Use JDK 17+ and allow Gradle sync. For testing use Build -> Build APK(s). For public distribution use Build -> Generate Signed App Bundle / APK -> APK and create one permanent OptiTrade signing key. Keep that key backed up offline and never commit it to GitHub. Rename the signed release APK to `OptiTrade.apk` and place it in `public/downloads/OptiTrade.apk` before pushing the APK to the production repository.
