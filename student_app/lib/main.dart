import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:qr_flutter/qr_flutter.dart';

import 'api.dart';
import 'config.dart';

void main() {
  runApp(const CampusWalletApp());
}

final api = CampusApi();
const _nfcChannel = MethodChannel('campus_wallet/nfc');
const _nfcEvents = EventChannel('campus_wallet/nfc_events');

class CampusWalletApp extends StatelessWidget {
  const CampusWalletApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Campus Wallet',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF0F6C5C)),
        useMaterial3: true,
      ),
      home: const RoleScreen(),
    );
  }
}

class RoleScreen extends StatefulWidget {
  const RoleScreen({super.key});

  @override
  State<RoleScreen> createState() => _RoleScreenState();
}

class _RoleScreenState extends State<RoleScreen> {
  final collegeId = TextEditingController();
  final password = TextEditingController();
  bool busy = false;
  String? error;

  Future<void> signIn() async {
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final data = await api.post('/login', {
        'collegeId': collegeId.text.trim(),
        'pin': password.text,
      });
      await api.saveToken(data['token'] as String);
      if (!mounted) return;
      final Widget screen = switch (data['role']) {
        'student' => const StudentHomeScreen(),
        'merchant' => const MerchantHomeScreen(),
        'admin' => const AdminHomeScreen(),
        _ => throw ApiException('Account could not be opened'),
      };
      Navigator.pushReplacement(context, MaterialPageRoute<void>(builder: (_) => screen));
    } catch (e) {
      setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Campus Wallet')),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 460),
          child: ListView(
            padding: const EdgeInsets.all(20),
            shrinkWrap: true,
            children: [
              Text('Campus payments, made simple', style: Theme.of(context).textTheme.headlineMedium),
              const SizedBox(height: 24),
              TextField(
                controller: collegeId,
                textInputAction: TextInputAction.next,
                decoration: const InputDecoration(labelText: 'ID'),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: password,
                obscureText: true,
                onSubmitted: (_) => signIn(),
                decoration: const InputDecoration(labelText: 'Password'),
              ),
              if (error != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(error!, style: const TextStyle(color: Colors.red))),
              const SizedBox(height: 20),
              FilledButton(onPressed: busy ? null : signIn, child: const Text('Continue')),
              TextButton(
                onPressed: busy
                    ? null
                    : () {
                        Navigator.push(
                          context,
                          MaterialPageRoute<void>(builder: (_) => const StudentAuthScreen()),
                        );
                      },
                child: const Text('Create a student account'),
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  void dispose() {
    collegeId.dispose();
    password.dispose();
    super.dispose();
  }
}

class AdminHomeScreen extends StatefulWidget {
  const AdminHomeScreen({super.key});

  @override
  State<AdminHomeScreen> createState() => _AdminHomeScreenState();
}

class _AdminHomeScreenState extends State<AdminHomeScreen> {
  List<dynamic> accounts = [];
  String? error;

  Future<void> refresh() async {
    try {
      final result = await api.get('/admin/accounts');
      setState(() {
        accounts = result['accounts'] as List<dynamic>? ?? [];
        error = null;
      });
    } catch (e) {
      setState(() => error = e.toString());
    }
  }

  @override
  void initState() {
    super.initState();
    refresh();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Accounts'),
        actions: [
          IconButton(
            onPressed: () async {
              await api.clearToken();
              if (!context.mounted) return;
              Navigator.popUntil(context, (route) => route.isFirst);
            },
            icon: const Icon(Icons.logout),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: refresh,
        child: ListView(
          children: [
            if (error != null) Padding(padding: const EdgeInsets.all(16), child: Text(error!, style: const TextStyle(color: Colors.red))),
            for (final account in accounts)
              ListTile(
                leading: CircleAvatar(
                  backgroundImage: profilePhoto(account['photoData']),
                  child: profilePhoto(account['photoData']) == null ? const Icon(Icons.person_outline) : null,
                ),
                title: Text(account['name']?.toString() ?? ''),
                subtitle: Text('${account['role'] == 'merchant' ? 'Canteen' : 'Student'} · ${account['collegeId']}'),
              ),
          ],
        ),
      ),
    );
  }
}

ImageProvider<Object>? profilePhoto(dynamic data) {
  if (data is! String || !data.startsWith('data:image/')) return null;
  final separator = data.indexOf(',');
  if (separator < 0) return null;
  try {
    return MemoryImage(base64Decode(data.substring(separator + 1)));
  } on FormatException {
    return null;
  }
}

String ledgerTypeLabel(dynamic type) {
  if (type == 'test_topup') return 'Top-up';
  if (type == 'qr_sale') return 'QR sale';
  if (type == 'nfc_transfer_out') return 'NFC payment sent';
  if (type == 'nfc_transfer_in') return 'NFC payment received';
  return '$type'.replaceAll('_', ' ');
}

String ledgerNote(dynamic entry) {
  return entry['entry_type'] == 'test_topup' ? '' : '${entry['note'] ?? ''}';
}

class StudentAuthScreen extends StatefulWidget {
  const StudentAuthScreen({super.key});

  @override
  State<StudentAuthScreen> createState() => _StudentAuthScreenState();
}

class _StudentAuthScreenState extends State<StudentAuthScreen> {
  final collegeId = TextEditingController(text: 'STU1001');
  final name = TextEditingController(text: 'Alex');
  final pin = TextEditingController(text: '1234');
  bool busy = false;
  String? error;

  Future<void> _go(Future<Map<String, dynamic>> Function() fn) async {
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final data = await fn();
      await api.saveToken(data['token'] as String);
      if (!mounted) return;
      Navigator.pushReplacement(
        context,
        MaterialPageRoute<void>(builder: (_) => const StudentHomeScreen()),
      );
    } catch (e) {
      setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  void dispose() {
    collegeId.dispose();
    name.dispose();
    pin.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Student login')),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          TextField(controller: collegeId, decoration: const InputDecoration(labelText: 'College ID')),
          TextField(controller: name, decoration: const InputDecoration(labelText: 'Name (signup only)')),
          TextField(
            controller: pin,
            decoration: const InputDecoration(labelText: 'PIN'),
            obscureText: true,
            keyboardType: TextInputType.number,
          ),
          if (error != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(error!, style: const TextStyle(color: Colors.red))),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: busy
                ? null
                : () => _go(
                      () => api.post('/students/login', {
                        'collegeId': collegeId.text.trim(),
                        'pin': pin.text.trim(),
                      }),
                    ),
            child: const Text('Log in'),
          ),
          OutlinedButton(
            onPressed: busy
                ? null
                : () => _go(
                      () => api.post('/students/signup', {
                        'collegeId': collegeId.text.trim(),
                        'name': name.text.trim(),
                        'pin': pin.text.trim(),
                      }),
                    ),
            child: const Text('Sign up'),
          ),
        ],
      ),
    );
  }
}

class StudentHomeScreen extends StatefulWidget {
  const StudentHomeScreen({super.key});

  @override
  State<StudentHomeScreen> createState() => _StudentHomeScreenState();
}

class _StudentHomeScreenState extends State<StudentHomeScreen> {
  Map<String, dynamic>? me;
  Map<String, dynamic>? qr;
  List<dynamic> ledger = [];
  String? error;
  Timer? _qrTimer;
  Timer? _receiveExpiryTimer;
  bool nfcAvailable = false;
  bool nfcHostCardEmulationAvailable = false;
  bool nfcBusy = false;
  String? nfcStatus;
  bool receivingByNfc = false;

  String rupees(dynamic paise) => '₹${(Money.paise(paise) / 100).toStringAsFixed(2)}';

  Future<void> showWalletScore() async {
    final cutoff = DateTime.now().toUtc().subtract(const Duration(days: 30));
    final recentEntries = ledger.where((row) {
      final createdAt = DateTime.tryParse('${row['created_at']}')?.toUtc();
      return createdAt != null && !createdAt.isAfter(DateTime.now().toUtc()) && !createdAt.isBefore(cutoff);
    }).toList();
    final activeDays = recentEntries
        .map((row) => DateTime.parse('${row['created_at']}').toUtc().toIso8601String().substring(0, 10))
        .toSet()
        .length;
    final statusPoints = me?['frozen'] == true ? 0 : 38;
    final activityPoints = recentEntries.length.clamp(0, 6).toInt() * 5;
    final daysPoints = activeDays.clamp(0, 8).toInt() * 4;
    final score = statusPoints + activityPoints + daysPoints;
    await showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Your wallet score'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Center(
              child: Text(
                '$score/100',
                style: Theme.of(context).textTheme.headlineLarge?.copyWith(
                      color: Theme.of(context).colorScheme.primary,
                      fontWeight: FontWeight.bold,
                    ),
              ),
            ),
            const SizedBox(height: 8),
            const Text('Free Campus Wallet activity score'),
            const SizedBox(height: 12),
            Text('Wallet status (max 38 points)  $statusPoints points'),
            Text('Activity in the last 30 days (max 30 points)  $activityPoints points'),
            Text('Active days in the last 30 days (max 32 points)  $daysPoints points'),
            const SizedBox(height: 12),
            const Text(
              'This score uses demo wallet activity only. It is not a CIBIL or other credit-bureau score, does not check your credit report, and does not affect loan eligibility.',
            ),
          ],
        ),
        actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('Done'))],
      ),
    );
  }

  Future<void> checkNfcCapabilities() async {
    try {
      final capabilities = await _nfcChannel.invokeMapMethod<String, bool>('capabilities');
      if (!mounted) return;
      setState(() {
        nfcAvailable = capabilities?['reader'] == true;
        nfcHostCardEmulationAvailable = capabilities?['hostCardEmulation'] == true;
      });
    } on PlatformException catch (e) {
      if (mounted) setState(() => nfcStatus = e.message ?? 'Could not check NFC support');
    }
  }

  Future<void> startNfcReceive() async {
    setState(() {
      nfcBusy = true;
      nfcStatus = null;
    });
    try {
      if (!nfcHostCardEmulationAvailable) {
        throw ApiException('This Android phone cannot receive NFC taps');
      }
      final session = await api.post('/students/nfc/session', {});
      await _nfcChannel.invokeMethod<void>('setReceiveToken', session['token']);
      _receiveExpiryTimer?.cancel();
      _receiveExpiryTimer = Timer(const Duration(minutes: 2), () {
        if (!mounted) return;
        _nfcChannel.invokeMethod<void>('clearReceiveToken');
        setState(() {
          receivingByNfc = false;
          nfcStatus = 'NFC receive session expired. Start a new one to receive.';
        });
      });
      setState(() {
        receivingByNfc = true;
        nfcStatus = 'Ready to receive one tap payment for 2 minutes.';
      });
    } catch (e) {
      setState(() => nfcStatus = e.toString());
    } finally {
      if (mounted) setState(() => nfcBusy = false);
    }
  }

  Future<void> stopNfcReceive() async {
    _receiveExpiryTimer?.cancel();
    try {
      await _nfcChannel.invokeMethod<void>('clearReceiveToken');
      if (mounted) setState(() => receivingByNfc = false);
    } on PlatformException catch (e) {
      if (mounted) setState(() => nfcStatus = e.message ?? 'Could not stop NFC receive mode');
    }
  }

  Future<int?> requestNfcAmount() async {
    final controller = TextEditingController();
    String? amountError;
    try {
      return await showDialog<int>(
        context: context,
        builder: (dialogContext) => StatefulBuilder(
          builder: (dialogContext, setDialogState) => AlertDialog(
            title: const Text('Send by NFC'),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Enter an amount up to ₹500. No PIN is needed.'),
                const SizedBox(height: 12),
                TextField(
                  controller: controller,
                  autofocus: true,
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  decoration: InputDecoration(
                    labelText: 'Amount in rupees',
                    prefixText: '₹ ',
                    errorText: amountError,
                  ),
                ),
              ],
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(dialogContext),
                child: const Text('Cancel'),
              ),
              FilledButton(
                onPressed: () {
                  final rupeeAmount = double.tryParse(controller.text.trim());
                  final paise = rupeeAmount == null ? null : (rupeeAmount * 100).round();
                  if (rupeeAmount == null ||
                      !rupeeAmount.isFinite ||
                      rupeeAmount <= 0 ||
                      paise == null ||
                      (rupeeAmount * 100 - paise).abs() > 0.000001 ||
                      paise > 50000) {
                    setDialogState(() => amountError = 'Enter an amount from ₹0.01 to ₹500.00');
                    return;
                  }
                  Navigator.pop(dialogContext, paise);
                },
                child: const Text('Tap to send'),
              ),
            ],
          ),
        ),
      );
    } finally {
      controller.dispose();
    }
  }

  Future<void> sendByNfc() async {
    if (nfcBusy) return;
    final amountPaise = await requestNfcAmount();
    if (amountPaise == null || !mounted) return;
    setState(() {
      nfcBusy = true;
      nfcStatus = 'Hold the phones together to read the recipient.';
    });
    final tokenCompleter = Completer<dynamic>();
    final nfcSubscription = _nfcEvents.receiveBroadcastStream().listen(
      tokenCompleter.complete,
      onError: tokenCompleter.completeError,
    );
    try {
      if (!nfcAvailable) throw ApiException('NFC reader is not available on this device');
      await _nfcChannel.invokeMethod<void>('startReader');
      final recipientToken = await tokenCompleter.future.timeout(const Duration(seconds: 45));
      if (recipientToken is! String || recipientToken.isEmpty) {
        throw ApiException('The NFC tap did not contain a valid receive session');
      }
      final result = await api.post('/students/nfc/transfer', {
        'recipientToken': recipientToken,
        'amountPaise': amountPaise,
      });
      if (!mounted) return;
      setState(() {
        nfcStatus = 'Sent ${rupees(result['amountPaise'])} to ${result['recipient']['name']}.';
      });
      await refresh();
    } catch (e) {
      if (mounted) setState(() => nfcStatus = e.toString());
    } finally {
      await nfcSubscription.cancel();
      try {
        await _nfcChannel.invokeMethod<void>('stopReader');
      } on PlatformException catch (e) {
        if (mounted && nfcStatus == null) {
          setState(() => nfcStatus = e.message ?? 'Could not stop NFC reader');
        }
      }
      if (mounted) setState(() => nfcBusy = false);
    }
  }

  Future<void> refresh() async {
    try {
      final profile = await api.get('/students/me');
      final book = await api.get('/students/ledger');
      setState(() {
        me = profile;
        ledger = book['entries'] as List<dynamic>? ?? [];
        error = null;
      });
      if (profile['frozen'] != true) {
        await loadQr();
      } else {
        setState(() => qr = null);
      }
    } catch (e) {
      setState(() => error = e.toString());
    }
  }

  Future<void> loadQr() async {
    try {
      final data = await api.get('/students/qr');
      setState(() => qr = data);
    } catch (e) {
      setState(() => error = e.toString());
    }
  }

  Future<void> topup() async {
    try {
      await api.post('/students/test-topup', {'amountPaise': 10000});
      await refresh();
    } catch (e) {
      setState(() => error = e.toString());
    }
  }

  Future<void> toggleFreeze() async {
    final pinController = TextEditingController();
    final frozen = me?['frozen'] == true;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(frozen ? 'Unfreeze account' : 'Freeze account'),
        content: TextField(
          controller: pinController,
          obscureText: true,
          decoration: const InputDecoration(labelText: 'PIN'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Confirm')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await api.post('/students/freeze', {'frozen': !frozen, 'pin': pinController.text});
      await refresh();
    } catch (e) {
      setState(() => error = e.toString());
    }
  }

  @override
  void initState() {
    super.initState();
    api.loadToken().then((_) => refresh());
    checkNfcCapabilities();
    _qrTimer = Timer.periodic(const Duration(seconds: 30), (_) {
      if (me?['frozen'] != true) loadQr();
    });
  }

  @override
  void dispose() {
    _qrTimer?.cancel();
    _receiveExpiryTimer?.cancel();
    _nfcChannel.invokeMethod<void>('clearReceiveToken');
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final token = qr?['token']?.toString() ?? '';
    final avatar = profilePhoto(me?['photoData']);
    return Scaffold(
      appBar: AppBar(
        title: Text(me?['collegeId']?.toString() ?? 'Student'),
        actions: [
          IconButton(
            onPressed: () async {
              await api.clearToken();
              if (!context.mounted) return;
              Navigator.popUntil(context, (route) => route.isFirst);
            },
            icon: const Icon(Icons.logout),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: refresh,
        child: ListView(
          padding: const EdgeInsets.all(20),
          children: [
            if (error != null) Text(error!, style: const TextStyle(color: Colors.red)),
            Row(
              children: [
                CircleAvatar(
                  radius: 30,
                  backgroundImage: avatar,
                  child: avatar == null ? const Icon(Icons.person_outline) : null,
                ),
                const SizedBox(width: 12),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(me?['name']?.toString() ?? 'Student', style: Theme.of(context).textTheme.titleMedium),
                    Text(me?['collegeId']?.toString() ?? '', style: Theme.of(context).textTheme.bodySmall),
                  ],
                ),
              ],
            ),
            const SizedBox(height: 8),
            Text(rupees(me?['balancePaise']), style: Theme.of(context).textTheme.headlineMedium),
            Text(me?['frozen'] == true ? 'FROZEN' : 'Active'),
            const SizedBox(height: 12),
            OutlinedButton.icon(
              onPressed: showWalletScore,
              icon: const Icon(Icons.stars_outlined),
              label: const Text('Check your wallet score · Free'),
            ),
            FilledButton(onPressed: topup, child: const Text('Add ₹100')),
            OutlinedButton(onPressed: toggleFreeze, child: Text(me?['frozen'] == true ? 'Unfreeze' : 'Freeze account')),
            const SizedBox(height: 16),
            Text('NFC tap to pay', style: Theme.of(context).textTheme.titleMedium),
            Text('Test-wallet transfers only · up to ₹500 per tap · ₹2,000 per day · no PIN'),
            const SizedBox(height: 8),
            FilledButton.icon(
              onPressed: nfcBusy || me?['frozen'] == true ? null : sendByNfc,
              icon: const Icon(Icons.nfc),
              label: Text(nfcBusy ? 'Waiting for tap…' : 'Send by tap'),
            ),
            OutlinedButton.icon(
              onPressed: nfcBusy || me?['frozen'] == true
                  ? null
                  : receivingByNfc
                      ? stopNfcReceive
                      : startNfcReceive,
              icon: Icon(receivingByNfc ? Icons.stop_circle_outlined : Icons.contactless),
              label: Text(receivingByNfc ? 'Stop receiving by tap' : 'Receive by tap'),
            ),
            if (nfcStatus != null)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(nfcStatus!),
              ),
            if (!nfcAvailable || !nfcHostCardEmulationAvailable)
              const Padding(
                padding: EdgeInsets.only(top: 4),
                child: Text('Two NFC-capable Android phones are required; one must support card emulation.'),
              ),
            const SizedBox(height: 16),
            if (token.isNotEmpty) ...[
              Center(
                child: QrImageView(data: token, size: 200),
              ),
              SelectableText(token),
              TextButton(
                onPressed: () {
                  Clipboard.setData(ClipboardData(text: token));
                },
                child: const Text('Copy QR text'),
              ),
            ],
            const SizedBox(height: 16),
            Text('History', style: Theme.of(context).textTheme.titleMedium),
            for (final row in ledger)
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: Text('${ledgerTypeLabel(row['entry_type'])}  ${row['amount_paise']} paise'),
                subtitle: Text([ledgerNote(row), '${row['created_at']}'].where((value) => value.isNotEmpty).join(' · ')),
              ),
          ],
        ),
      ),
    );
  }
}

class Money {
  static int paise(dynamic value) {
    if (value is int) return value;
    if (value is num) return value.toInt();
    return int.tryParse('$value') ?? 0;
  }
}

class MerchantAuthScreen extends StatefulWidget {
  const MerchantAuthScreen({super.key});

  @override
  State<MerchantAuthScreen> createState() => _MerchantAuthScreenState();
}

class _MerchantAuthScreenState extends State<MerchantAuthScreen> {
  final collegeId = TextEditingController(text: 'CANTEEN1');
  final pin = TextEditingController(text: '1234');
  bool busy = false;
  String? error;

  @override
  void dispose() {
    collegeId.dispose();
    pin.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Canteen login')),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          TextField(controller: collegeId, decoration: const InputDecoration(labelText: 'Merchant college ID')),
          TextField(controller: pin, obscureText: true, decoration: const InputDecoration(labelText: 'PIN')),
          if (error != null) Text(error!, style: const TextStyle(color: Colors.red)),
          const SizedBox(height: 12),
          FilledButton(
            onPressed: busy
                ? null
                : () async {
                    setState(() => busy = true);
                    try {
                      final data = await api.post('/merchants/login', {
                        'collegeId': collegeId.text.trim(),
                        'pin': pin.text.trim(),
                      });
                      await api.saveToken(data['token'] as String);
                      if (!context.mounted) return;
                      Navigator.pushReplacement(
                        context,
                        MaterialPageRoute<void>(builder: (_) => const MerchantHomeScreen()),
                      );
                    } catch (e) {
                      setState(() => error = e.toString());
                    } finally {
                      if (mounted) setState(() => busy = false);
                    }
                  },
            child: const Text('Log in'),
          ),
        ],
      ),
    );
  }
}

class MerchantHomeScreen extends StatefulWidget {
  const MerchantHomeScreen({super.key});

  @override
  State<MerchantHomeScreen> createState() => _MerchantHomeScreenState();
}

class _MerchantHomeScreenState extends State<MerchantHomeScreen> {
  final token = TextEditingController();
  final rupees = TextEditingController(text: '40');
  Map<String, dynamic>? me;
  List<dynamic> ledger = [];
  String? error;

  Future<void> refresh() async {
    try {
      final profile = await api.get('/merchants/me');
      final book = await api.get('/merchants/ledger');
      setState(() {
        me = profile;
        ledger = book['entries'] as List<dynamic>? ?? [];
        error = null;
      });
    } catch (e) {
      setState(() => error = e.toString());
    }
  }

  Future<void> charge() async {
    final rupeeValue = double.tryParse(rupees.text.trim());
    if (rupeeValue == null || rupeeValue <= 0) {
      setState(() => error = 'Enter a rupee amount');
      return;
    }
    final paise = (rupeeValue * 100).round();
    try {
      await api.post('/merchants/charge', {
        'token': token.text.trim(),
        'amountPaise': paise,
      });
      token.clear();
      await refresh();
    } catch (e) {
      setState(() => error = e.toString());
    }
  }

  @override
  void initState() {
    super.initState();
    api.loadToken().then((_) => refresh());
  }

  @override
  void dispose() {
    token.dispose();
    rupees.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(me?['collegeId']?.toString() ?? 'Canteen'),
        actions: [
          IconButton(
            onPressed: () async {
              await api.clearToken();
              if (!context.mounted) return;
              Navigator.popUntil(context, (route) => route.isFirst);
            },
            icon: const Icon(Icons.logout),
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          Text('Sales balance: ₹${(Money.paise(me?['balancePaise']) / 100).toStringAsFixed(2)}'),
          if (error != null) Text(error!, style: const TextStyle(color: Colors.red)),
          TextField(
            controller: token,
            decoration: const InputDecoration(labelText: 'Student QR text'),
            minLines: 2,
            maxLines: 3,
          ),
          TextField(
            controller: rupees,
            decoration: const InputDecoration(labelText: 'Charge (₹)'),
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
          ),
          const SizedBox(height: 8),
          FilledButton(onPressed: charge, child: const Text('Charge')),
          const SizedBox(height: 16),
          Text('Sales history', style: Theme.of(context).textTheme.titleMedium),
          for (final row in ledger)
            ListTile(
              contentPadding: EdgeInsets.zero,
                title: Text('${ledgerTypeLabel(row['entry_type'])}  ${row['amount_paise']} paise'),
                subtitle: Text(ledgerNote(row)),
            ),
        ],
      ),
    );
  }
}
