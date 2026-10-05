/// Default for a local desktop run. Physical Android builds must override this
/// with the computer's LAN URL, for example via --dart-define=API_BASE=...
const String apiBase = String.fromEnvironment(
  'API_BASE',
  defaultValue: 'http://127.0.0.1:3000',
);
