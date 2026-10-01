/// Local API only. Android emulator: http://10.0.2.2:3000
const String apiBase = String.fromEnvironment(
  'API_BASE',
  defaultValue: 'http://127.0.0.1:3000',
);
