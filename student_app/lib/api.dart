import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'config.dart';

class ApiException implements Exception {
  ApiException(this.message);
  final String message;
  @override
  String toString() => message;
}

class CampusApi {
  CampusApi();

  String? token;

  Future<void> loadToken() async {
    final prefs = await SharedPreferences.getInstance();
    token = prefs.getString('cw_token');
  }

  Future<void> saveToken(String value) async {
    token = value;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('cw_token', value);
  }

  Future<void> clearToken() async {
    token = null;
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove('cw_token');
  }

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        if (token != null) 'Authorization': 'Bearer $token',
      };

  Future<Map<String, dynamic>> _parse(http.Response res) async {
    Map<String, dynamic> body = {};
    if (res.body.isNotEmpty) {
      final decoded = jsonDecode(res.body);
      if (decoded is Map<String, dynamic>) body = decoded;
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw ApiException(body['error']?.toString() ?? 'Request failed (${res.statusCode})');
    }
    return body;
  }

  Future<http.Response> _request(Future<http.Response> Function() send) async {
    try {
      return await send().timeout(const Duration(seconds: 15));
    } on TimeoutException {
      throw ApiException('Campus Wallet API did not respond at $apiBase. Check that the server is running and reachable.');
    } on http.ClientException {
      throw ApiException(
        'Cannot connect to Campus Wallet API at $apiBase. On a physical phone, use your computer LAN address when building the app.',
      );
    }
  }

  Future<Map<String, dynamic>> post(String path, Map<String, dynamic> json) async {
    final res = await _request(
      () => http.post(
        Uri.parse('$apiBase$path'),
        headers: _headers,
        body: jsonEncode(json),
      ),
    );
    return _parse(res);
  }

  Future<Map<String, dynamic>> get(String path) async {
    final res = await _request(() => http.get(Uri.parse('$apiBase$path'), headers: _headers));
    return _parse(res);
  }
}
