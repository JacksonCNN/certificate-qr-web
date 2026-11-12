// version.js — this build's version number, checked against the latest
// GitHub Release tag (settings.js's "Check for updates"). Set this to
// match the tag whenever you cut a release (e.g. tag "v1.2.0" → set
// this to '1.2.0') — a browser holding an older copy keeps whatever
// APP_VERSION it was shipped with, which is exactly what makes it
// compare as "behind" once a newer release is published. The Android
// app carries its own copy of this number — bump versionName (and
// versionCode) in android/app/build.gradle at the same time.
//
// Publishing a release with a higher number is also what updates the
// Android app: updater.js downloads the release's www/ and runs the app
// from that, with no reinstall. The files have to say the same version
// as the tag, or the updater turns the release down.
const APP_VERSION = '1.2.8';

// Which Android side this version of the web files needs. An update
// downloaded by updater.js replaces everything in www/ but can't touch
// the installed Android app around it — so when a release needs
// something new from that (a plugin added, a permission, a change to
// MainActivity), raise this number in the same release. Installed apps
// with a lower number then leave that release alone and say it needs
// reinstalling, instead of downloading files they can't run.
const NATIVE_API = 1;
