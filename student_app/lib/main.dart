import 'dart:async';
import 'dart:convert';
import 'dart:math';

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

String newRequestId() {
  final random = Random.secure();
  final suffix = List<int>.generate(16, (_) => random.nextInt(256))
      .map((value) => value.toRadixString(16).padLeft(2, '0'))
      .join();
  return '${DateTime.now().toUtc().microsecondsSinceEpoch}_$suffix';
}

class CampusWalletLogo extends StatelessWidget {
  const CampusWalletLogo({super.key, this.size = 36});

  final double size;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [Color(0xFF159879), Color(0xFF075344)],
        ),
        borderRadius: BorderRadius.circular(size * 0.28),
        boxShadow: [
          BoxShadow(
            color: const Color(0xFF075344).withValues(alpha: 0.22),
            blurRadius: size * 0.16,
            offset: Offset(0, size * 0.08),
          ),
        ],
      ),
      child: Stack(
        alignment: Alignment.center,
        children: [
          Icon(Icons.account_balance_wallet_rounded,
              size: size * 0.68, color: Colors.white),
          Positioned(
            top: size * 0.13,
            right: size * 0.12,
            child: Container(
              width: size * 0.24,
              height: size * 0.24,
              decoration: const BoxDecoration(
                  color: Color(0xFFF6D782), shape: BoxShape.circle),
              child: Icon(Icons.account_balance_rounded,
                  size: size * 0.15, color: const Color(0xFF694D0D)),
            ),
          ),
        ],
      ),
    );
  }
}

class CampusWalletApp extends StatelessWidget {
  const CampusWalletApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Campus Wallet',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF0F6C5C)),
        scaffoldBackgroundColor: const Color(0xFFEDF3F1),
        appBarTheme: const AppBarTheme(
          backgroundColor: Color(0xFF173431),
          foregroundColor: Colors.white,
        ),
        inputDecorationTheme: InputDecorationTheme(
          filled: true,
          fillColor: Colors.white,
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(8),
            borderSide: const BorderSide(color: Color(0xFFD9E7E1)),
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(8),
            borderSide: const BorderSide(color: Color(0xFFD9E7E1)),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(8),
            borderSide: const BorderSide(color: Color(0xFF0A8B6B), width: 2),
          ),
        ),
        filledButtonTheme: FilledButtonThemeData(
          style: FilledButton.styleFrom(
            backgroundColor: const Color(0xFF0A8B6B),
            foregroundColor: Colors.white,
            minimumSize: const Size(0, 48),
            shape:
                RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
          ),
        ),
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
      Navigator.pushReplacement(
          context, MaterialPageRoute<void>(builder: (_) => screen));
    } catch (e) {
      if (!mounted) return;
      setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Row(
          children: [
            CampusWalletLogo(),
            SizedBox(width: 10),
            Text('Campus Wallet'),
          ],
        ),
      ),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 460),
          child: ListView(
            padding: const EdgeInsets.fromLTRB(20, 28, 20, 32),
            children: [
              Container(
                padding: const EdgeInsets.all(24),
                decoration: BoxDecoration(
                  color: const Color(0xFF173431),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const CampusWalletLogo(size: 58),
                    const SizedBox(height: 18),
                    const Text(
                      'CAMPUS WALLET',
                      style: TextStyle(
                          color: Color(0xFFB9D9C9),
                          fontWeight: FontWeight.w700,
                          letterSpacing: 1.2),
                    ),
                    const SizedBox(height: 12),
                    Text(
                      'Campus payments, made simple',
                      style: Theme.of(context)
                          .textTheme
                          .headlineSmall
                          ?.copyWith(
                              color: Colors.white, fontWeight: FontWeight.w800),
                    ),
                    const SizedBox(height: 8),
                    const Text('Sign in to access your campus wallet.',
                        style: TextStyle(color: Color(0xFFD7E7DF))),
                  ],
                ),
              ),
              const SizedBox(height: 16),
              Card(
                margin: EdgeInsets.zero,
                child: Padding(
                  padding: const EdgeInsets.all(20),
                  child: Column(
                    children: [
                      TextField(
                        controller: collegeId,
                        textInputAction: TextInputAction.next,
                        decoration: const InputDecoration(
                            labelText: 'Student, canteen, or admin ID'),
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: password,
                        obscureText: true,
                        onSubmitted: (_) => signIn(),
                        decoration: const InputDecoration(
                            labelText: 'PIN or admin key'),
                      ),
                      if (error != null)
                        Padding(
                          padding: const EdgeInsets.only(top: 12),
                          child: Text(error!,
                              style: const TextStyle(color: Colors.red)),
                        ),
                      const SizedBox(height: 16),
                      SizedBox(
                          width: double.infinity,
                          child: FilledButton(
                              onPressed: busy ? null : signIn,
                              child: const Text('Continue'))),
                      TextButton(
                        onPressed: busy
                            ? null
                            : () {
                                Navigator.push(
                                  context,
                                  MaterialPageRoute<void>(
                                      builder: (_) =>
                                          const StudentAuthScreen()),
                                );
                              },
                        child: const Text('Create a student account'),
                      ),
                      TextButton(
                        onPressed: busy
                            ? null
                            : () {
                                Navigator.push(
                                  context,
                                  MaterialPageRoute<void>(
                                      builder: (_) =>
                                          const MerchantAuthScreen()),
                                );
                              },
                        child: const Text('Canteen portal login'),
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 12),
              Text(
                'API: $apiBase',
                textAlign: TextAlign.center,
                style: Theme.of(context)
                    .textTheme
                    .bodySmall
                    ?.copyWith(color: const Color(0xFF5E6F78)),
              ),
              const SizedBox(height: 4),
              Text(
                'For a physical phone, this must be your computer’s LAN address, not 127.0.0.1.',
                textAlign: TextAlign.center,
                style: Theme.of(context)
                    .textTheme
                    .bodySmall
                    ?.copyWith(color: const Color(0xFF5E6F78)),
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
      if (!mounted) return;
      setState(() {
        accounts = result['accounts'] as List<dynamic>? ?? [];
        error = null;
      });
    } catch (e) {
      if (!mounted) return;
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
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 28),
          children: [
            Text('Campus accounts',
                style: Theme.of(context)
                    .textTheme
                    .headlineSmall
                    ?.copyWith(fontWeight: FontWeight.w800)),
            const SizedBox(height: 12),
            if (error != null)
              Card(
                color: const Color(0xFFFFF0EF),
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child:
                      Text(error!, style: const TextStyle(color: Colors.red)),
                ),
              ),
            for (final account in accounts)
              Card(
                margin: const EdgeInsets.only(bottom: 8),
                child: ListTile(
                  leading: CircleAvatar(
                    backgroundImage: profilePhoto(account['photoData']),
                    child: profilePhoto(account['photoData']) == null
                        ? const Icon(Icons.person_outline)
                        : null,
                  ),
                  title: Text(account['name']?.toString() ?? ''),
                  subtitle: Text(
                    account['role'] == 'merchant'
                        ? 'Canteen · ${account['collegeId']}'
                        : 'Student · ${account['collegeId']} · ${account['cardLevel'] ?? 'STARROW'}',
                  ),
                ),
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
  if (type == 'card_membership_fee') return 'Card membership';
  if (type == 'transfer_fee') return 'Transfer fee';
  if (type == 'withdrawal_fee') return 'Withdrawal fee';
  if (type == 'event_free_entry') return 'Free entry';
  if (type == 'event_free_entry_refund') return 'Free entry returned';
  if (type == 'team_payback') return 'Team payback';
  if (type == 'team_payback_refund') return 'Team payback returned';
  if (type == 'student_transfer_out') return 'Sent to friend';
  if (type == 'student_transfer_in') return 'Received from friend';
  if (type == 'nfc_transfer_out') return 'NFC payment sent';
  if (type == 'nfc_transfer_in') return 'NFC payment received';
  return '$type'.replaceAll('_', ' ');
}

String accountInitial(dynamic name) {
  final value = '$name'.trim();
  return value.isEmpty ? '?' : value[0].toUpperCase();
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
  final email = TextEditingController();
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
      if (!mounted) return;
      setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  void dispose() {
    collegeId.dispose();
    name.dispose();
    email.dispose();
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
          TextField(
              controller: collegeId,
              decoration: const InputDecoration(labelText: 'College ID')),
          TextField(
              controller: name,
              decoration:
                  const InputDecoration(labelText: 'Name (signup only)')),
          TextField(
            controller: email,
            keyboardType: TextInputType.emailAddress,
            autocorrect: false,
            decoration:
                const InputDecoration(labelText: 'College email (signup only)'),
          ),
          TextField(
            controller: pin,
            decoration: const InputDecoration(labelText: 'PIN'),
            obscureText: true,
            keyboardType: TextInputType.number,
          ),
          if (error != null)
            Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(error!, style: const TextStyle(color: Colors.red))),
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
                        'email': email.text.trim(),
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
  List<dynamic> friends = [];
  List<dynamic> events = [];
  List<dynamic> teams = [];
  Map<String, dynamic> eventEntries = {};
  final emailController = TextEditingController();
  final verificationCodeController = TextEditingController();
  final inviteTokenController = TextEditingController();
  String? error;
  Timer? _qrTimer;
  Timer? _receiveExpiryTimer;
  Timer? _friendSearchTimer;
  int selectedTab = 0;
  String _activityFilter = 'All';
  String _activitySearch = '';
  String _activityPeriod = 'All time';
  bool friendsBusy = false;
  bool nfcAvailable = false;
  bool nfcHostCardEmulationAvailable = false;
  bool nfcBusy = false;
  String? nfcStatus;
  bool receivingByNfc = false;

  String rupees(dynamic paise) =>
      '₹${(Money.paise(paise) / 100).toStringAsFixed(2)}';

  List<dynamic> get _periodLedger {
    if (_activityPeriod == 'All time') return ledger;
    final days = _activityPeriod == '7 days' ? 7 : 30;
    final now = DateTime.now();
    final cutoff = now.subtract(Duration(days: days));
    return ledger.where((row) {
      final createdAt = DateTime.tryParse('${row['created_at'] ?? ''}');
      return createdAt != null &&
          !createdAt.isBefore(cutoff) &&
          !createdAt.isAfter(now);
    }).toList();
  }

  List<dynamic> get _filteredLedger => _periodLedger.where((row) {
        final amount = Money.paise(row['amount_paise']);
        final matchesDirection = _activityFilter == 'All' ||
            (_activityFilter == 'Money in' && amount >= 0) ||
            (_activityFilter == 'Money out' && amount < 0);
        if (!matchesDirection) return false;
        final query = _activitySearch.trim().toLowerCase();
        if (query.isEmpty) return true;
        final searchableText = [
          ledgerTypeLabel(row['entry_type']),
          ledgerNote(row),
          '${row['created_at'] ?? ''}',
          rupees(amount.abs()),
        ].join(' ').toLowerCase();
        return searchableText.contains(query);
      }).toList();

  Future<void> showCardLevels() async {
    try {
      final result = await api.get('/students/card-levels');
      if (!mounted) return;
      final rawLevels = result['catalog']?['levels'];
      if (rawLevels is! List)
        throw ApiException('Card-level catalog is unavailable');
      final levels = rawLevels
          .whereType<Map>()
          .map((item) => Map<String, dynamic>.from(item))
          .toList();
      final membership = Map<String, dynamic>.from(result['membership'] as Map);
      var selectedLevel = membership['level'] == 'STARROW'
          ? 'FENWICK'
          : '${membership['level']}';
      var period = 'semester';
      var busy = false;
      String? purchaseError;

      await showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        showDragHandle: true,
        builder: (sheetContext) => StatefulBuilder(
          builder: (sheetContext, setSheetState) {
            final selected = levels.firstWhere(
              (item) => item['name'] == selectedLevel,
              orElse: () => levels.first,
            );
            final prices = Map<String, dynamic>.from(selected['prices'] as Map);
            final pricePaise = selectedLevel == 'FENWICK'
                ? Money.paise(prices[
                    period == 'semester' ? 'semesterPaise' : 'yearPaise'])
                : Money.paise(result['emberfallPurchasePricePaise']);
            final isFrozen = me?['frozen'] == true;
            return SafeArea(
              child: SizedBox(
                height: MediaQuery.of(sheetContext).size.height * 0.84,
                child: Column(
                  children: [
                    Padding(
                      padding: const EdgeInsets.fromLTRB(20, 4, 20, 12),
                      child: Row(
                        children: [
                          Expanded(
                            child: Text(
                              'Choose your card level',
                              style: Theme.of(context)
                                  .textTheme
                                  .titleLarge
                                  ?.copyWith(fontWeight: FontWeight.w800),
                            ),
                          ),
                          Chip(
                            avatar: const Icon(Icons.verified_user_outlined,
                                size: 16),
                            label: Text('Current: ${membership['level']}'),
                          ),
                        ],
                      ),
                    ),
                    if (membership['renewalReminder'] != null)
                      Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 16),
                        child: Card(
                          color: const Color(0xFFFFF3D9),
                          child: ListTile(
                            leading: const Icon(
                                Icons.notifications_active_outlined,
                                color: Color(0xFF986116)),
                            title: const Text('Renewal reminder'),
                            subtitle: Text(
                                '${membership['renewalReminder']} Memberships renew manually.'),
                          ),
                        ),
                      ),
                    if (membership['benefitsPaused'] == true)
                      const Padding(
                        padding: EdgeInsets.symmetric(horizontal: 16),
                        child: Card(
                          color: Color(0xFFFFF0EF),
                          child: ListTile(
                            leading: Icon(Icons.pause_circle_outline,
                                color: Colors.red),
                            title: Text('Card benefits paused'),
                            subtitle: Text(
                                'Unfreeze your wallet to use card-level benefits.'),
                          ),
                        ),
                      ),
                    Expanded(
                      child: ListView(
                        padding: const EdgeInsets.fromLTRB(16, 4, 16, 12),
                        children: [
                          for (final card in levels)
                            _cardLevelOption(
                              card,
                              selected: selectedLevel == card['name'],
                              onTap: () => setSheetState(() {
                                selectedLevel = '${card['name']}';
                                purchaseError = null;
                              }),
                            ),
                          if (selectedLevel == 'FENWICK')
                            Padding(
                              padding: const EdgeInsets.symmetric(
                                  horizontal: 4, vertical: 8),
                              child: Wrap(
                                spacing: 8,
                                children: [
                                  ChoiceChip(
                                    label: const Text('Semester'),
                                    selected: period == 'semester',
                                    onSelected: (_) => setSheetState(
                                        () => period = 'semester'),
                                  ),
                                  ChoiceChip(
                                    label: const Text('Year'),
                                    selected: period == 'year',
                                    onSelected: (_) =>
                                        setSheetState(() => period = 'year'),
                                  ),
                                ],
                              ),
                            ),
                          if (selectedLevel == 'EMBERFALL')
                            const Padding(
                              padding: EdgeInsets.fromLTRB(8, 0, 8, 8),
                              child: Text(
                                  'Manual yearly renewal. After expiry, Emberfall has a 15-day grace period before falling back to your previous level.'),
                            ),
                          if (purchaseError != null)
                            Padding(
                              padding: const EdgeInsets.all(8),
                              child: Text(purchaseError!,
                                  style: const TextStyle(color: Colors.red)),
                            ),
                          FilledButton.icon(
                            onPressed: busy || isFrozen
                                ? null
                                : () async {
                                    setSheetState(() {
                                      busy = true;
                                      purchaseError = null;
                                    });
                                    try {
                                      await api.post(
                                          '/students/card-levels/purchase', {
                                        'level': selectedLevel,
                                        'period': selectedLevel == 'FENWICK'
                                            ? period
                                            : 'year',
                                        'requestId': newRequestId(),
                                      });
                                      if (!sheetContext.mounted) return;
                                      Navigator.pop(sheetContext);
                                      await refresh();
                                      if (!mounted) return;
                                      ScaffoldMessenger.of(context)
                                          .showSnackBar(
                                        SnackBar(
                                            content: Text(
                                                '$selectedLevel membership is active.')),
                                      );
                                    } catch (e) {
                                      if (!sheetContext.mounted) return;
                                      setSheetState(() {
                                        purchaseError = e.toString();
                                        busy = false;
                                      });
                                    }
                                  },
                            icon: const Icon(Icons.lock_outline),
                            label: Text(
                              busy
                                  ? 'Processing…'
                                  : 'Pay ${rupees(pricePaise)} from wallet',
                            ),
                          ),
                          const Padding(
                            padding: EdgeInsets.only(top: 8),
                            child: Text(
                              'Test mode only. Membership charges use your wallet balance; no live payment or bank service is connected.',
                              textAlign: TextAlign.center,
                              style: TextStyle(
                                  fontSize: 11, color: Color(0xFF6C7A89)),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            );
          },
        ),
      );
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    }
  }

  Future<void> requestWithdrawal() async {
    final amountController = TextEditingController();
    final holderController =
        TextEditingController(text: '${me?['name'] ?? ''}');
    final destinationController = TextEditingController();
    final pinController = TextEditingController();
    var destinationType = 'upi';
    var busy = false;
    String? dialogError;
    Map<String, dynamic>? quote;
    try {
      final completed = await showDialog<bool>(
        context: context,
        builder: (dialogContext) => StatefulBuilder(
          builder: (dialogContext, setDialogState) => AlertDialog(
            title: const Text('Withdraw (test simulation)'),
            content: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Text(
                      'No money leaves the demo wallet. Your name must match your student account.'),
                  const SizedBox(height: 12),
                  TextField(
                    controller: amountController,
                    keyboardType:
                        const TextInputType.numberWithOptions(decimal: true),
                    decoration: const InputDecoration(labelText: 'Amount (₹)'),
                    onChanged: (_) => setDialogState(() {
                      quote = null;
                      dialogError = null;
                    }),
                  ),
                  const SizedBox(height: 10),
                  DropdownButtonFormField<String>(
                    initialValue: destinationType,
                    decoration:
                        const InputDecoration(labelText: 'Destination type'),
                    items: const [
                      DropdownMenuItem(value: 'upi', child: Text('UPI ID')),
                      DropdownMenuItem(
                          value: 'bank', child: Text('Bank account')),
                    ],
                    onChanged: (value) => setDialogState(() {
                      destinationType = value ?? 'upi';
                      quote = null;
                    }),
                  ),
                  const SizedBox(height: 10),
                  TextField(
                    controller: destinationController,
                    decoration: InputDecoration(
                      labelText: destinationType == 'upi'
                          ? 'Test UPI ID'
                          : 'Test bank account number',
                    ),
                    onChanged: (_) => setDialogState(() {
                      quote = null;
                      dialogError = null;
                    }),
                  ),
                  const SizedBox(height: 10),
                  TextField(
                    controller: holderController,
                    decoration:
                        const InputDecoration(labelText: 'Account holder name'),
                    onChanged: (_) => setDialogState(() {
                      quote = null;
                      dialogError = null;
                    }),
                  ),
                  if (quote != null) ...[
                    const SizedBox(height: 10),
                    Card(
                      color: const Color(0xFFEAF5F8),
                      child: Padding(
                        padding: const EdgeInsets.all(12),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Text('Fee shown before confirmation',
                                style: TextStyle(fontWeight: FontWeight.w800)),
                            Text(
                                'Withdrawal: ${rupees(quote!['amountPaise'])}'),
                            Text('Fee: ${rupees(quote!['feePaise'])}'),
                            Text(
                                'Total wallet debit: ${rupees(quote!['totalDebitPaise'])}',
                                style: const TextStyle(
                                    fontWeight: FontWeight.w700)),
                          ],
                        ),
                      ),
                    ),
                    TextField(
                      controller: pinController,
                      obscureText: true,
                      keyboardType: TextInputType.number,
                      decoration: const InputDecoration(
                          labelText: 'Confirm with wallet PIN'),
                    ),
                  ],
                  if (dialogError != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 10),
                      child: Text(dialogError!,
                          style: const TextStyle(color: Colors.red)),
                    ),
                ],
              ),
            ),
            actions: [
              TextButton(
                onPressed:
                    busy ? null : () => Navigator.pop(dialogContext, false),
                child: const Text('Cancel'),
              ),
              FilledButton(
                onPressed: busy
                    ? null
                    : () async {
                        final rupeeAmount =
                            double.tryParse(amountController.text.trim());
                        final amountPaise = rupeeAmount == null
                            ? null
                            : (rupeeAmount * 100).round();
                        if (rupeeAmount == null ||
                            !rupeeAmount.isFinite ||
                            amountPaise == null ||
                            amountPaise <= 0 ||
                            (rupeeAmount * 100 - amountPaise).abs() >
                                0.000001) {
                          setDialogState(() =>
                              dialogError = 'Enter a valid amount in rupees.');
                          return;
                        }
                        setDialogState(() {
                          busy = true;
                          dialogError = null;
                        });
                        try {
                          if (quote == null) {
                            final preview =
                                await api.post('/students/withdrawal/quote', {
                              'amountPaise': amountPaise,
                            });
                            if (!dialogContext.mounted) return;
                            setDialogState(() {
                              quote = preview;
                              busy = false;
                            });
                            return;
                          }
                          final result =
                              await api.post('/students/withdrawal', {
                            'amountPaise': amountPaise,
                            'requestId': newRequestId(),
                            'destinationType': destinationType,
                            'destination': destinationController.text.trim(),
                            'accountHolderName': holderController.text.trim(),
                            'pin': pinController.text,
                          });
                          if (!dialogContext.mounted) return;
                          Navigator.pop(dialogContext, true);
                          if (mounted) {
                            ScaffoldMessenger.of(context).showSnackBar(
                              SnackBar(content: Text('${result['message']}')),
                            );
                          }
                        } catch (e) {
                          if (!dialogContext.mounted) return;
                          setDialogState(() {
                            dialogError = e.toString();
                            busy = false;
                          });
                          pinController.clear();
                        }
                      },
                child: Text(
                  busy
                      ? (quote == null ? 'Checking fee…' : 'Processing…')
                      : (quote == null ? 'Show fee' : 'Confirm withdrawal'),
                ),
              ),
            ],
          ),
        ),
      );
      if (completed == true) await refresh();
    } finally {
      amountController.dispose();
      holderController.dispose();
      destinationController.dispose();
      pinController.dispose();
    }
  }

  Widget _cardLevelOption(
    Map<String, dynamic> card, {
    required bool selected,
    required VoidCallback onTap,
  }) {
    final name = '${card['name']}';
    final prices = Map<String, dynamic>.from(card['prices'] as Map);
    final priceLabel = switch (name) {
      'STARROW' => 'Free · no renewal',
      'FENWICK' =>
        '${rupees(prices['semesterPaise'])} / semester · ${rupees(prices['yearPaise'])} / year',
      _ =>
        '${rupees(prices['firstYearPaise'])} first year · ${rupees(prices['renewalYearPaise'])} renewal / year',
    };
    final benefits =
        (card['benefits'] as List<dynamic>? ?? []).map((item) => '$item');
    final palette = switch (name) {
      'STARROW' => (const Color(0xFF4684A8), const Color(0xFFE8F5FC)),
      'FENWICK' => (const Color(0xFF398A79), const Color(0xFFE8F7F0)),
      _ => (const Color(0xFF986A29), const Color(0xFFFFF4DA)),
    };
    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      color: selected ? palette.$2 : Colors.white,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(
            color: selected ? palette.$1 : const Color(0xFFE2E8EF),
            width: selected ? 2 : 1),
      ),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(16),
        child: Padding(
          padding: const EdgeInsets.all(15),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  CircleAvatar(
                    backgroundColor: palette.$1,
                    child: Icon(
                        name == 'EMBERFALL'
                            ? Icons.local_fire_department
                            : Icons.credit_card,
                        color: Colors.white),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                      child: Text(name,
                          style: const TextStyle(
                              fontWeight: FontWeight.w800, fontSize: 17))),
                  Text(priceLabel,
                      textAlign: TextAlign.end,
                      style: TextStyle(
                          color: palette.$1,
                          fontWeight: FontWeight.w700,
                          fontSize: 11)),
                ],
              ),
              const SizedBox(height: 9),
              for (final benefit in benefits)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Icon(Icons.check_circle_outline,
                          size: 16, color: palette.$1),
                      const SizedBox(width: 7),
                      Expanded(
                          child: Text(benefit,
                              style: const TextStyle(fontSize: 12))),
                    ],
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> showWalletScore() async {
    final cutoff = DateTime.now().toUtc().subtract(const Duration(days: 30));
    final recentEntries = ledger.where((row) {
      final createdAt = DateTime.tryParse('${row['created_at']}')?.toUtc();
      return createdAt != null &&
          !createdAt.isAfter(DateTime.now().toUtc()) &&
          !createdAt.isBefore(cutoff);
    }).toList();
    final activeDays = recentEntries
        .map((row) => DateTime.parse('${row['created_at']}')
            .toUtc()
            .toIso8601String()
            .substring(0, 10))
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
            Text(
                'Activity in the last 30 days (max 30 points)  $activityPoints points'),
            Text(
                'Active days in the last 30 days (max 32 points)  $daysPoints points'),
            const SizedBox(height: 12),
            const Text(
              'This score uses demo wallet activity only. It is not a CIBIL or other credit-bureau score, does not check your credit report, and does not affect loan eligibility.',
            ),
          ],
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Done'))
        ],
      ),
    );
  }

  Future<void> checkNfcCapabilities() async {
    try {
      final capabilities =
          await _nfcChannel.invokeMapMethod<String, bool>('capabilities');
      if (!mounted) return;
      setState(() {
        nfcAvailable = capabilities?['reader'] == true;
        nfcHostCardEmulationAvailable =
            capabilities?['hostCardEmulation'] == true;
      });
    } on PlatformException catch (e) {
      if (!mounted) return;
      setState(() => nfcStatus = e.message ?? 'Could not check NFC support');
    }
  }

  Future<void> startNfcReceive() async {
    if (!mounted) return;
    setState(() {
      nfcBusy = true;
      nfcStatus = null;
    });
    try {
      if (!nfcHostCardEmulationAvailable) {
        throw ApiException('This Android phone cannot receive NFC taps');
      }
      final session = await api.post('/students/nfc/session', {});
      if (!mounted) return;
      await _nfcChannel.invokeMethod<void>('setReceiveToken', session['token']);
      _receiveExpiryTimer?.cancel();
      _receiveExpiryTimer = Timer(const Duration(minutes: 2), () {
        if (!mounted) return;
        _nfcChannel.invokeMethod<void>('clearReceiveToken');
        if (!mounted) return;
        setState(() {
          receivingByNfc = false;
          nfcStatus =
              'NFC receive session expired. Start a new one to receive.';
        });
      });
      if (!mounted) return;
      setState(() {
        receivingByNfc = true;
        nfcStatus = 'Ready to receive one tap payment for 2 minutes.';
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => nfcStatus = e.toString());
    } finally {
      if (!mounted) return;
      setState(() => nfcBusy = false);
    }
  }

  Future<void> stopNfcReceive() async {
    _receiveExpiryTimer?.cancel();
    try {
      await _nfcChannel.invokeMethod<void>('clearReceiveToken');
      if (!mounted) return;
      setState(() => receivingByNfc = false);
    } on PlatformException catch (e) {
      if (!mounted) return;
      setState(
          () => nfcStatus = e.message ?? 'Could not stop NFC receive mode');
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
                  keyboardType:
                      const TextInputType.numberWithOptions(decimal: true),
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
                  final paise =
                      rupeeAmount == null ? null : (rupeeAmount * 100).round();
                  if (rupeeAmount == null ||
                      !rupeeAmount.isFinite ||
                      rupeeAmount <= 0 ||
                      paise == null ||
                      (rupeeAmount * 100 - paise).abs() > 0.000001 ||
                      paise > 50000) {
                    setDialogState(() =>
                        amountError = 'Enter an amount from ₹0.01 to ₹500.00');
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
    late final Map<String, dynamic> quote;
    try {
      quote = await api
          .post('/students/transfer/quote', {'amountPaise': amountPaise});
    } catch (e) {
      if (mounted) setState(() => nfcStatus = e.toString());
      return;
    }
    if (!mounted) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Confirm NFC payment'),
        content: Text(
          'Transfer: ${rupees(quote['amountPaise'])}\n'
          'Fee: ${rupees(quote['feePaise'])}\n'
          'Total wallet debit: ${rupees(quote['totalDebitPaise'])}',
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(dialogContext, false),
              child: const Text('Cancel')),
          FilledButton(
              onPressed: () => Navigator.pop(dialogContext, true),
              child: const Text('Continue to tap')),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
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
      if (!nfcAvailable)
        throw ApiException('NFC reader is not available on this device');
      await _nfcChannel.invokeMethod<void>('startReader');
      final recipientToken =
          await tokenCompleter.future.timeout(const Duration(seconds: 45));
      if (recipientToken is! String || recipientToken.isEmpty) {
        throw ApiException(
            'The NFC tap did not contain a valid receive session');
      }
      final result = await api.post('/students/nfc/transfer', {
        'recipientToken': recipientToken,
        'amountPaise': amountPaise,
        'requestId': newRequestId(),
      });
      if (!mounted) return;
      setState(() {
        nfcStatus =
            'Sent ${rupees(result['amountPaise'])} to ${result['recipient']['name']} · fee ${rupees(result['feePaise'])}.';
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
      final directory = await api.get('/students/directory');
      final eventCatalog = await api.get('/events');
      final entryInventory = await api.get('/students/event-entries');
      final teamList = await api.get('/students/teams');
      if (!mounted) return;
      setState(() {
        me = profile;
        ledger = book['entries'] as List<dynamic>? ?? [];
        friends = directory['students'] as List<dynamic>? ?? [];
        events = eventCatalog['events'] as List<dynamic>? ?? [];
        teams = teamList['teams'] as List<dynamic>? ?? [];
        eventEntries = Map<String, dynamic>.from(entryInventory);
        if (emailController.text.isEmpty && profile['email'] != null) {
          emailController.text = '${profile['email']}';
        }
        error = null;
      });
      if (!mounted) return;
      if (profile['frozen'] != true) {
        await loadQr();
      } else {
        setState(() => qr = null);
      }
    } catch (e) {
      if (!mounted) return;
      setState(() => error = e.toString());
    }
  }

  Future<void> loadQr() async {
    try {
      final data = await api.get('/students/qr');
      if (!mounted) return;
      setState(() => qr = data);
    } catch (e) {
      if (!mounted) return;
      setState(() => error = e.toString());
    }
  }

  Future<void> topup() async {
    try {
      await api.post('/students/test-topup', {'amountPaise': 10000});
      await refresh();
    } catch (e) {
      if (!mounted) return;
      setState(() => error = e.toString());
    }
  }

  Future<void> buyEventEntry() async {
    try {
      await api.post(
          '/students/event-entries/top-up', {'requestId': newRequestId()});
      await refresh();
    } catch (e) {
      if (!mounted) return;
      setState(() => error = e.toString());
    }
  }

  Future<void> requestEmailVerification() async {
    try {
      await api.post('/students/email-verification/request', {
        'email': emailController.text.trim(),
      });
      if (!mounted) return;
      setState(() => error =
          'If eligible, a verification email was sent. In TEST_MODE check the API log.');
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    }
  }

  Future<void> confirmEmailVerification() async {
    try {
      await api.post('/students/email-verification/confirm', {
        'code': verificationCodeController.text.trim(),
      });
      verificationCodeController.clear();
      await refresh();
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    }
  }

  Future<void> acceptTeamInvite() async {
    try {
      await api.post('/students/team-invites/accept', {
        'token': inviteTokenController.text.trim(),
      });
      inviteTokenController.clear();
      await refresh();
      if (mounted) setState(() => error = 'You joined the team.');
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    }
  }

  Future<void> registerForEvent(Map<String, dynamic> event) async {
    final teamName = TextEditingController();
    final memberEmails = TextEditingController();
    final teamSize = Money.paise(event['teamSize']);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text('Register for ${event['title']}'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
                'Team fee: ${rupees(event['feePaise'])} total for $teamSize students.'),
            if (teamSize > 1) ...[
              const SizedBox(height: 12),
              TextField(
                controller: teamName,
                decoration: const InputDecoration(labelText: 'Team name'),
                textCapitalization: TextCapitalization.words,
              ),
              const SizedBox(height: 8),
              const Text(
                  'Invite the other team members using their verified college emails, separated by commas.'),
              const SizedBox(height: 8),
              TextField(
                controller: memberEmails,
                decoration: const InputDecoration(
                    labelText: 'Team member college emails'),
                keyboardType: TextInputType.emailAddress,
                autocorrect: false,
              ),
            ],
            const SizedBox(height: 8),
            const Text(
                'An Emberfall member’s active free entry covers only that member’s share. The leader pays the team fee up front.'),
          ],
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(dialogContext, false),
              child: const Text('Cancel')),
          FilledButton(
              onPressed: () => Navigator.pop(dialogContext, true),
              child: const Text('Register')),
        ],
      ),
    );
    if (confirmed != true) {
      teamName.dispose();
      memberEmails.dispose();
      return;
    }
    final members = memberEmails.text
        .split(',')
        .map((value) => value.trim())
        .where((value) => value.isNotEmpty)
        .toList();
    final selectedTeamName = teamName.text.trim();
    teamName.dispose();
    memberEmails.dispose();

    try {
      final result = await api.post('/events/${event['id']}/register', {
        'requestId': newRequestId(),
        'teamName': selectedTeamName,
        'memberEmails': members,
      });
      if (!mounted) return;
      final details = (result['members'] as List<dynamic>? ?? [])
          .map((item) =>
              '${item['role'] == 'leader' ? item['collegeId'] : item['email']}: share ${rupees(item['sharePaise'])}, ${item['invitationPending'] == true ? 'invitation sent' : 'covered ${rupees(item['coveredPaise'])}'}')
          .join('\n');
      await showDialog<void>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          icon: const Icon(Icons.event_available,
              color: Color(0xFF4AA866), size: 48),
          title: const Text('Event registration confirmed'),
          content: Text(
            'Team: ${result['teamName']}\nPaid from leader wallet: ${rupees(result['paidPaise'])}${details.isEmpty ? '' : '\n\n$details'}',
          ),
          actions: [
            FilledButton(
                onPressed: () => Navigator.pop(dialogContext),
                child: const Text('Done')),
          ],
        ),
      );
      await refresh();
    } catch (e) {
      if (!mounted) return;
      setState(() => error = e.toString());
    }
  }

  Future<void> _payTeamShare(
      Map<String, dynamic> team, Map<String, dynamic> member) async {
    final pinController = TextEditingController();
    final pin = await showDialog<String>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Confirm team payback'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
                'Send your remaining share of ${rupees(member['duePaise'])} to ${team['leaderName']}?'),
            const SizedBox(height: 12),
            TextField(
              controller: pinController,
              obscureText: true,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: 'Wallet PIN'),
            ),
          ],
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(dialogContext),
              child: const Text('Cancel')),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, pinController.text),
            child: const Text('Pay share'),
          ),
        ],
      ),
    );
    pinController.dispose();
    if (pin == null || pin.isEmpty) return;
    try {
      final result =
          await api.post('/students/teams/${team['teamId']}/payback', {
        'requestId': newRequestId(),
        'amountPaise': Money.paise(member['duePaise']),
        'pin': pin,
      });
      if (!mounted) return;
      await refresh();
      setState(() {
        error =
            'Team payback sent: ${rupees(result['amountPaise'])} · fee ${rupees(result['feePaise'])}.';
      });
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    }
  }

  Future<void> _remindTeamMember(
      Map<String, dynamic> team, String collegeId) async {
    try {
      await api.post('/students/teams/${team['teamId']}/remind', {
        'memberCollegeId': collegeId,
      });
      if (!mounted) return;
      setState(() =>
          error = 'Payback reminder sent. In TEST_MODE, check the API log.');
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    }
  }

  Future<void> _resendTeamInvite(
      Map<String, dynamic> team, String email) async {
    try {
      await api.post('/students/teams/${team['teamId']}/invites/resend', {
        'requestId': newRequestId(),
        'email': email,
      });
      if (!mounted) return;
      await refresh();
      setState(
          () => error = 'Invitation resent. In TEST_MODE, check the API log.');
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    }
  }

  Widget _emailVerificationCard() {
    final verified = me?['emailVerified'] == true;
    if (verified) return const SizedBox.shrink();
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Verify your college email',
                style: TextStyle(fontWeight: FontWeight.w800)),
            const SizedBox(height: 6),
            const Text(
                'Team registration and invitations require a verified email on an allowed college domain.'),
            const SizedBox(height: 10),
            TextField(
              controller: emailController,
              keyboardType: TextInputType.emailAddress,
              autocorrect: false,
              decoration: const InputDecoration(labelText: 'College email'),
            ),
            const SizedBox(height: 8),
            FilledButton.tonal(
              onPressed: requestEmailVerification,
              child: const Text('Send verification code'),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: verificationCodeController,
              keyboardType: TextInputType.number,
              maxLength: 6,
              decoration: const InputDecoration(labelText: '6-digit code'),
            ),
            FilledButton(
              onPressed: confirmEmailVerification,
              child: const Text('Verify email'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _teamTrackerCard(Map<String, dynamic> team) {
    final isLeader = team['isLeader'] == true;
    final members = (team['members'] as List<dynamic>? ?? [])
        .map((item) => Map<String, dynamic>.from(item as Map))
        .toList();
    final invites = (team['invites'] as List<dynamic>? ?? [])
        .map((item) => Map<String, dynamic>.from(item as Map))
        .toList();
    Map<String, dynamic>? self;
    for (final member in members) {
      if (member['collegeId'] == me?['collegeId']) {
        self = member;
        break;
      }
    }
    final cancelled = team['status'] == 'cancelled';
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('${team['teamName']}',
                style: const TextStyle(fontWeight: FontWeight.w800)),
            Text('${team['eventTitle']} · ${team['status']}'),
            Text(
                'Team fee ${rupees(team['teamFeePaise'])} · leader ${team['leaderName']}'),
            const Divider(),
            for (final member in members)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: Text(
                        '${member['name']} · ${member['role']}\nShare ${rupees(member['sharePaise'])} · due ${rupees(member['duePaise'])}',
                      ),
                    ),
                    if (isLeader &&
                        !cancelled &&
                        member['role'] == 'member' &&
                        Money.paise(member['duePaise']) > 0)
                      TextButton(
                        onPressed: () =>
                            _remindTeamMember(team, '${member['collegeId']}'),
                        child: const Text('Remind'),
                      ),
                    if (!isLeader &&
                        !cancelled &&
                        self?['collegeId'] == member['collegeId'] &&
                        Money.paise(member['duePaise']) > 0 &&
                        !('${eventEntries['cardLevel']}' == 'STARROW' &&
                            Money.paise(member['paybackCount']) > 0))
                      FilledButton.tonal(
                        onPressed: () => _payTeamShare(team, member),
                        child: const Text('Pay share'),
                      ),
                  ],
                ),
              ),
            if (isLeader)
              for (final invite
                  in invites.where((item) => item['pending'] == true))
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  title: Text('${invite['email']}'),
                  subtitle: Text(
                      'Pending invitation · share ${rupees(invite['sharePaise'])}'),
                  trailing: TextButton(
                    onPressed: cancelled
                        ? null
                        : () => _resendTeamInvite(team, '${invite['email']}'),
                    child: const Text('Resend'),
                  ),
                ),
            if (!isLeader &&
                self != null &&
                Money.paise(self['duePaise']) > 0 &&
                '${eventEntries['cardLevel']}' == 'STARROW' &&
                Money.paise(self['paybackCount']) > 0)
              const Text('Your one STARROW payback has already been used.'),
          ],
        ),
      ),
    );
  }

  Widget _eventsContent() {
    final cardLevel = '${eventEntries['cardLevel'] ?? 'STARROW'}';
    final yearlyFree = Money.paise(eventEntries['yearlyFreeEntries']);
    final topUpEntries = Money.paise(eventEntries['topUpEntries']);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('Campus events',
            style: Theme.of(context)
                .textTheme
                .headlineSmall
                ?.copyWith(fontWeight: FontWeight.w800)),
        const SizedBox(height: 4),
        const Text(
            'Register with your wallet. Event fees and entry benefits are checked by the server.'),
        const SizedBox(height: 12),
        _emailVerificationCard(),
        if (me?['emailVerified'] == true)
          Card(
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('Accept a team invitation',
                      style: TextStyle(fontWeight: FontWeight.w800)),
                  const SizedBox(height: 8),
                  TextField(
                    controller: inviteTokenController,
                    decoration:
                        const InputDecoration(labelText: 'Invite token'),
                    autocorrect: false,
                  ),
                  const SizedBox(height: 8),
                  FilledButton.tonal(
                    onPressed: acceptTeamInvite,
                    child: const Text('Accept invitation'),
                  ),
                ],
              ),
            ),
          ),
        if (teams.isNotEmpty) ...[
          const SizedBox(height: 8),
          Text('Your teams',
              style: Theme.of(context)
                  .textTheme
                  .titleLarge
                  ?.copyWith(fontWeight: FontWeight.w800)),
          for (final rawTeam in teams)
            _teamTrackerCard(Map<String, dynamic>.from(rawTeam as Map)),
        ],
        const SizedBox(height: 8),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('EMBERFALL entries · $cardLevel',
                    style: const TextStyle(fontWeight: FontWeight.w800)),
                const SizedBox(height: 6),
                Text('$yearlyFree yearly free · $topUpEntries paid top-up'),
                const Text(
                    'The yearly entry is used first and expires at renewal. Top-ups carry while Emberfall stays active; they expire after a lapse beyond grace.'),
                const SizedBox(height: 10),
                FilledButton.tonalIcon(
                  onPressed: cardLevel == 'EMBERFALL' ? buyEventEntry : null,
                  icon: const Icon(Icons.add_circle_outline),
                  label: Text(
                      'Buy one event entry · ${rupees(eventEntries['topUpPricePaise'] ?? 29900)}'),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 8),
        if (events.isEmpty)
          const Card(
              child: Padding(
                  padding: EdgeInsets.all(16),
                  child: Text('No upcoming events yet.')))
        else
          for (final rawEvent in events)
            Builder(builder: (context) {
              final event = Map<String, dynamic>.from(rawEvent as Map);
              final teamSize = Money.paise(event['teamSize']);
              return Card(
                child: Padding(
                  padding: const EdgeInsets.all(14),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('${event['title']}',
                          style: Theme.of(context)
                              .textTheme
                              .titleMedium
                              ?.copyWith(fontWeight: FontWeight.w800)),
                      if ('${event['description'] ?? ''}'.isNotEmpty) ...[
                        const SizedBox(height: 4),
                        Text('${event['description']}'),
                      ],
                      const SizedBox(height: 8),
                      Text(
                          'Organizer: ${event['organizer']?['name'] ?? event['organizer']?['collegeId'] ?? 'Campus'}'),
                      Text(
                          'Fee: ${rupees(event['feePaise'])} total · $teamSize ${teamSize == 1 ? 'student' : 'students'}'),
                      const SizedBox(height: 8),
                      SizedBox(
                        width: double.infinity,
                        child: FilledButton(
                          onPressed: event['registered'] == true
                              ? null
                              : () => registerForEvent(event),
                          child: Text(event['registered'] == true
                              ? 'Registered'
                              : 'Register'),
                        ),
                      ),
                    ],
                  ),
                ),
              );
            }),
      ],
    );
  }

  Future<void> loadFriends(String query) async {
    setState(() {
      friendsBusy = true;
    });
    try {
      final result = await api
          .get('/students/directory?q=${Uri.encodeQueryComponent(query)}');
      if (!mounted) return;
      setState(() => friends = result['students'] as List<dynamic>? ?? []);
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => friendsBusy = false);
    }
  }

  void searchFriends(String query) {
    _friendSearchTimer?.cancel();
    _friendSearchTimer = Timer(
        const Duration(milliseconds: 250), () => loadFriends(query.trim()));
  }

  Future<void> openActivity() async {
    if (!mounted) return;
    setState(() => selectedTab = 1);
  }

  Future<void> showBalance() async {
    final pinController = TextEditingController();
    String? dialogError;
    var busy = false;
    await showDialog<void>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (dialogContext, setDialogState) => AlertDialog(
          title: const Text('Check your balance'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('Enter your wallet PIN to view your current balance.'),
              const SizedBox(height: 14),
              TextField(
                controller: pinController,
                obscureText: true,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(labelText: 'Wallet PIN'),
              ),
              if (dialogError != null)
                Padding(
                  padding: const EdgeInsets.only(top: 10),
                  child: Text(dialogError!,
                      style: const TextStyle(color: Colors.red)),
                ),
            ],
          ),
          actions: [
            TextButton(
                onPressed: busy ? null : () => Navigator.pop(dialogContext),
                child: const Text('Cancel')),
            FilledButton(
              onPressed: busy
                  ? null
                  : () async {
                      setDialogState(() {
                        busy = true;
                        dialogError = null;
                      });
                      try {
                        final result = await api.post(
                            '/students/balance', {'pin': pinController.text});
                        if (!dialogContext.mounted) return;
                        Navigator.pop(dialogContext);
                        if (!mounted) return;
                        await showDialog<void>(
                          context: context,
                          builder: (resultContext) => AlertDialog(
                            icon: const Icon(Icons.check_circle,
                                color: Color(0xFF4AA866), size: 64),
                            title: const Text('Balance fetched successfully'),
                            content: Text(
                              rupees(result['balancePaise']),
                              textAlign: TextAlign.center,
                              style: Theme.of(context)
                                  .textTheme
                                  .headlineMedium
                                  ?.copyWith(fontWeight: FontWeight.w800),
                            ),
                            actions: [
                              FilledButton(
                                  onPressed: () => Navigator.pop(resultContext),
                                  child: const Text('Done'))
                            ],
                          ),
                        );
                      } catch (e) {
                        setDialogState(() {
                          dialogError = e.toString();
                          busy = false;
                        });
                      }
                    },
              child: Text(busy ? 'Checking…' : 'Show balance'),
            ),
          ],
        ),
      ),
    );
    pinController.dispose();
  }

  Future<void> showMyQr() async {
    if (me?['frozen'] == true) {
      setState(() => error = 'Unfreeze your wallet to show your payment QR.');
      return;
    }
    await loadQr();
    if (!mounted || qr?['token'] == null) return;
    final token = qr!['token'].toString();
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 8, 24, 28),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text('My payment QR',
                  style: Theme.of(context)
                      .textTheme
                      .titleLarge
                      ?.copyWith(fontWeight: FontWeight.w800)),
              const SizedBox(height: 8),
              const Text('Let a campus merchant scan this code to pay.'),
              const SizedBox(height: 12),
              QrImageView(data: token, size: 220),
              SelectableText(token, textAlign: TextAlign.center),
              TextButton.icon(
                onPressed: () => Clipboard.setData(ClipboardData(text: token)),
                icon: const Icon(Icons.copy),
                label: const Text('Copy QR text'),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> openFriendChat(Map<String, dynamic> friend) async {
    await Navigator.push<void>(
      context,
      MaterialPageRoute<void>(
        builder: (_) => StudentChatScreen(
          friend: friend,
          currentStudentId: '${me?['id'] ?? ''}',
          moneyFormatter: rupees,
        ),
      ),
    );
    if (mounted) await refresh();
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
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('Cancel')),
          FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('Confirm')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await api.post(
          '/students/freeze', {'frozen': !frozen, 'pin': pinController.text});
      await refresh();
    } catch (e) {
      if (!mounted) return;
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
    _friendSearchTimer?.cancel();
    emailController.dispose();
    verificationCodeController.dispose();
    inviteTokenController.dispose();
    _nfcChannel.invokeMethod<void>('clearReceiveToken');
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final isFrozen = me?['frozen'] == true;
    final actions = [
      _WalletAction(Icons.add, 'Add money', topup),
      _WalletAction(Icons.qr_code_2, 'My QR', showMyQr),
      _WalletAction(Icons.receipt_long, 'Activity', openActivity),
      _WalletAction(isFrozen ? Icons.lock_open : Icons.pause_circle_outline,
          isFrozen ? 'Unfreeze' : 'Freeze', toggleFreeze),
    ];
    return Scaffold(
      appBar: AppBar(
        title: const Row(
          children: [
            CampusWalletLogo(),
            SizedBox(width: 10),
            Text('Campus Wallet'),
          ],
        ),
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
        child: LayoutBuilder(
          builder: (context, constraints) {
            final wide = constraints.maxWidth >= 720;
            return ListView(
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 28),
              children: [
                if (error != null)
                  Card(
                    color: const Color(0xFFFFF0EF),
                    child: Padding(
                      padding: const EdgeInsets.all(12),
                      child: Text(error!,
                          style: const TextStyle(color: Colors.red)),
                    ),
                  ),
                if (selectedTab == 0)
                  wide
                      ? Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            SizedBox(
                                width: 170,
                                child: _actionPanel(actions, vertical: true)),
                            const SizedBox(width: 18),
                            Expanded(child: _homeContent(isFrozen)),
                          ],
                        )
                      : Column(
                          children: [
                            _actionPanel(actions, vertical: false),
                            const SizedBox(height: 16),
                            _homeContent(isFrozen),
                          ],
                        )
                else if (selectedTab == 1)
                  _activityContent()
                else
                  _eventsContent(),
              ],
            );
          },
        ),
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: selectedTab,
        onDestinationSelected: (index) => setState(() => selectedTab = index),
        destinations: const [
          NavigationDestination(
              icon: Icon(Icons.home_outlined),
              selectedIcon: Icon(Icons.home),
              label: 'Home'),
          NavigationDestination(
              icon: Icon(Icons.receipt_long_outlined),
              selectedIcon: Icon(Icons.receipt_long),
              label: 'Activity'),
          NavigationDestination(
              icon: Icon(Icons.event_outlined),
              selectedIcon: Icon(Icons.event),
              label: 'Events'),
        ],
      ),
    );
  }

  Widget _actionPanel(List<_WalletAction> actions, {required bool vertical}) {
    final children = [
      for (final action in actions)
        _WalletActionButton(action: action, vertical: vertical),
    ];
    if (vertical) {
      return Card(
        margin: EdgeInsets.zero,
        color: const Color(0xFFF7F9FC),
        child: Padding(
          padding: const EdgeInsets.all(10),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Padding(
                padding: EdgeInsets.fromLTRB(5, 4, 5, 8),
                child: Text('WALLET ACTIONS',
                    style: TextStyle(
                        fontSize: 10,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 1)),
              ),
              for (final action in actions)
                _WalletActionButton(action: action, vertical: true),
            ],
          ),
        ),
      );
    }
    return Row(
        children: [for (final child in children) Expanded(child: child)]);
  }

  Widget _homeContent(bool isFrozen) {
    final membership = me?['cardMembership'] is Map
        ? Map<String, dynamic>.from(me!['cardMembership'] as Map)
        : <String, dynamic>{};
    final cardLevel = '${membership['level'] ?? 'STARROW'}';
    final cardColor = switch (cardLevel) {
      'EMBERFALL' => const Color(0xFF986A29),
      'FENWICK' => const Color(0xFF287B70),
      _ => const Color(0xFF397DA3),
    };
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _campusHero(),
        const SizedBox(height: 12),
        Card(
          margin: EdgeInsets.zero,
          clipBehavior: Clip.antiAlias,
          child: Container(
            decoration: BoxDecoration(
              gradient: LinearGradient(
                colors: [
                  cardLevel == 'EMBERFALL'
                      ? const Color(0xFFFFF5E1)
                      : const Color(0xFFEAF5FC),
                  Colors.white,
                ],
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
              ),
            ),
            child: ListTile(
              contentPadding:
                  const EdgeInsets.symmetric(horizontal: 16, vertical: 7),
              leading: CircleAvatar(
                backgroundColor: cardColor,
                child: Icon(
                  cardLevel == 'EMBERFALL'
                      ? Icons.local_fire_department
                      : Icons.credit_card,
                  color: Colors.white,
                ),
              ),
              title: Text('$cardLevel card',
                  style: const TextStyle(fontWeight: FontWeight.w800)),
              subtitle: Text(
                isFrozen
                    ? 'Benefits paused while your wallet is frozen'
                    : membership['reminderDue'] == true
                        ? 'Renewal reminder · manual renewal'
                        : membership['expiresAt'] == null
                            ? 'Free · no renewal'
                            : 'Active until ${DateTime.tryParse('${membership['expiresAt']}')?.toLocal().toString().split(' ').first ?? ''}',
              ),
              trailing: Icon(Icons.chevron_right, color: cardColor),
              onTap: showCardLevels,
            ),
          ),
        ),
        const SizedBox(height: 8),
        Card(
          margin: EdgeInsets.zero,
          child: ListTile(
            leading: const CircleAvatar(
              backgroundColor: Color(0xFFFFE8E4),
              child: Icon(Icons.account_balance_outlined,
                  color: Color(0xFFB65E4B)),
            ),
            title: const Text('Withdraw to bank or UPI',
                style: TextStyle(fontWeight: FontWeight.w700)),
            subtitle:
                const Text('Test simulation · see the fee before confirming'),
            trailing: const Icon(Icons.chevron_right),
            onTap: isFrozen ? null : requestWithdrawal,
          ),
        ),
        const SizedBox(height: 12),
        Card(
          margin: EdgeInsets.zero,
          child: ListTile(
            leading: const CircleAvatar(
                backgroundColor: Color(0xFFEBFAF6),
                child: Icon(Icons.currency_rupee, color: Color(0xFF056E57))),
            title: const Text('Check balance',
                style: TextStyle(fontWeight: FontWeight.w800)),
            subtitle: const Text('Enter your PIN to view it'),
            trailing: const Icon(Icons.chevron_right),
            onTap: showBalance,
          ),
        ),
        const SizedBox(height: 10),
        Card(
          margin: EdgeInsets.zero,
          child: ListTile(
            leading: const CircleAvatar(
                backgroundColor: Color(0xFFEBFAF6),
                child: Icon(Icons.stars_outlined, color: Color(0xFF056E57))),
            title: const Text('Check your wallet score',
                style: TextStyle(fontWeight: FontWeight.w700)),
            subtitle: const Text('Free · based on your Campus Wallet activity'),
            trailing: const Icon(Icons.chevron_right),
            onTap: showWalletScore,
          ),
        ),
        const SizedBox(height: 16),
        Text('People',
            style: Theme.of(context)
                .textTheme
                .titleLarge
                ?.copyWith(fontWeight: FontWeight.w800)),
        const SizedBox(height: 4),
        const Text('Open a chat to message or pay a campus friend.'),
        const SizedBox(height: 10),
        TextField(
          onChanged: searchFriends,
          decoration: InputDecoration(
            prefixIcon: const Icon(Icons.search),
            hintText: 'Search by name or campus ID',
            suffixIcon: friendsBusy
                ? const Padding(
                    padding: EdgeInsets.all(12),
                    child: SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2)))
                : null,
          ),
        ),
        const SizedBox(height: 8),
        if (friends.isEmpty)
          const Card(
              child: Padding(
                  padding: EdgeInsets.all(16),
                  child: Text('No campus friends found.')))
        else
          Card(
            margin: EdgeInsets.zero,
            child: Column(
              children: [
                for (final item in friends)
                  if (item is Map<String, dynamic>)
                    ListTile(
                      leading: CircleAvatar(
                        backgroundImage: profilePhoto(item['photoData']),
                        child: profilePhoto(item['photoData']) == null
                            ? Text(accountInitial(item['name']))
                            : null,
                      ),
                      title: Text('${item['name'] ?? ''}'),
                      subtitle: Text('${item['collegeId'] ?? ''}'),
                      trailing: const Icon(Icons.chat_bubble_outline),
                      onTap: () => openFriendChat(item),
                    ),
              ],
            ),
          ),
        const SizedBox(height: 16),
        _nfcCard(isFrozen),
      ],
    );
  }

  Widget _campusHero() {
    return Container(
      constraints: const BoxConstraints(minHeight: 160),
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          colors: [Color(0xFFE7F5FF), Color(0xFFEDF8FF), Color(0xFFE2F0D4)],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(18),
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                const Text('CAMPUS WALLET',
                    style: TextStyle(
                        color: Color(0xFF056E57),
                        fontWeight: FontWeight.w800,
                        letterSpacing: 1.1)),
                const SizedBox(height: 10),
                Text(
                  'Hey, ${me?['name']?.toString().split(' ').first ?? 'Student'}',
                  style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                      fontWeight: FontWeight.w800,
                      color: const Color(0xFF10252E)),
                ),
                const SizedBox(height: 4),
                const Text('Your campus money, all in one place.'),
              ],
            ),
          ),
          InkWell(
            onTap: showBalance,
            borderRadius: BorderRadius.circular(24),
            child: Semantics(
              button: true,
              label: 'Tap to check your balance with your PIN',
              child: Container(
                width: 86,
                height: 104,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: const Color(0xFFFAFCFF),
                  border: Border.all(color: const Color(0xFF8CAEC8), width: 2),
                  borderRadius: BorderRadius.circular(14),
                  boxShadow: const [
                    BoxShadow(
                        color: Color(0x667294AE),
                        offset: Offset(7, 8),
                        blurRadius: 0),
                    BoxShadow(
                        color: Color(0x3333475D),
                        offset: Offset(11, 13),
                        blurRadius: 14),
                  ],
                ),
                child: const Icon(Icons.account_balance_rounded,
                    size: 48, color: Color(0xFF668EB1)),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _nfcCard(bool isFrozen) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('NFC tap to pay',
            style: Theme.of(context)
                .textTheme
                .titleLarge
                ?.copyWith(fontWeight: FontWeight.w800)),
        const SizedBox(height: 8),
        Card(
          margin: EdgeInsets.zero,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                    'Test-wallet transfers only · up to ₹500 per tap · ₹2,000 per day · no PIN'),
                const SizedBox(height: 12),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton.icon(
                    onPressed: nfcBusy || isFrozen ? null : sendByNfc,
                    icon: const Icon(Icons.nfc),
                    label: Text(nfcBusy ? 'Waiting for tap…' : 'Send by tap'),
                  ),
                ),
                SizedBox(
                  width: double.infinity,
                  child: OutlinedButton.icon(
                    onPressed: nfcBusy || isFrozen
                        ? null
                        : receivingByNfc
                            ? stopNfcReceive
                            : startNfcReceive,
                    icon: Icon(receivingByNfc
                        ? Icons.stop_circle_outlined
                        : Icons.contactless),
                    label: Text(receivingByNfc
                        ? 'Stop receiving by tap'
                        : 'Receive by tap'),
                  ),
                ),
                if (nfcStatus != null) Text(nfcStatus!),
                if (!nfcAvailable || !nfcHostCardEmulationAvailable)
                  const Text(
                      'Two NFC-capable Android phones are required; one must support card emulation.'),
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget _activityContent() {
    final periodEntries = _periodLedger;
    final incomingCount = periodEntries
        .where((row) => Money.paise(row['amount_paise']) >= 0)
        .length;
    final outgoingCount = periodEntries.length - incomingCount;
    final entries = _filteredLedger;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('Activity',
            style: Theme.of(context)
                .textTheme
                .headlineSmall
                ?.copyWith(fontWeight: FontWeight.w800)),
        const SizedBox(height: 4),
        const Text('Your wallet transaction history'),
        const SizedBox(height: 12),
        Wrap(
          spacing: 8,
          children: [
            ChoiceChip(
              label: Text('All (${periodEntries.length})'),
              selected: _activityFilter == 'All',
              onSelected: (_) => setState(() => _activityFilter = 'All'),
            ),
            ChoiceChip(
              label: Text('Money in ($incomingCount)'),
              selected: _activityFilter == 'Money in',
              onSelected: (_) => setState(() => _activityFilter = 'Money in'),
            ),
            ChoiceChip(
              label: Text('Money out ($outgoingCount)'),
              selected: _activityFilter == 'Money out',
              onSelected: (_) => setState(() => _activityFilter = 'Money out'),
            ),
          ],
        ),
        const SizedBox(height: 8),
        const Text('Date range', style: TextStyle(fontWeight: FontWeight.w700)),
        const SizedBox(height: 4),
        Wrap(
          spacing: 8,
          children: [
            for (final period in ['All time', '7 days', '30 days'])
              ChoiceChip(
                label: Text(period),
                selected: _activityPeriod == period,
                onSelected: (_) => setState(() => _activityPeriod = period),
              ),
          ],
        ),
        const SizedBox(height: 8),
        TextField(
          decoration: InputDecoration(
            labelText: 'Search transactions',
            hintText: 'Search type, note, date, or amount',
            prefixIcon: const Icon(Icons.search),
            suffixIcon: _activitySearch.isEmpty
                ? null
                : IconButton(
                    tooltip: 'Clear search',
                    onPressed: () => setState(() => _activitySearch = ''),
                    icon: const Icon(Icons.clear),
                  ),
          ),
          onChanged: (value) => setState(() => _activitySearch = value),
        ),
        const SizedBox(height: 8),
        Card(
          margin: EdgeInsets.zero,
          child: entries.isEmpty
              ? Padding(
                  padding: const EdgeInsets.all(16),
                  child: Text(
                    ledger.isEmpty
                        ? 'No wallet activity yet.'
                        : _activitySearch.trim().isNotEmpty
                            ? 'No transactions match your search.'
                            : _activityPeriod == 'All time'
                                ? 'No ${_activityFilter.toLowerCase()} transactions yet.'
                                : 'No ${_activityFilter.toLowerCase()} transactions in the last $_activityPeriod.',
                  ),
                )
              : Column(
                  children: [
                    for (final row in entries)
                      ListTile(
                        leading: CircleAvatar(
                          backgroundColor: row['amount_paise'] is num &&
                                  (row['amount_paise'] as num) < 0
                              ? const Color(0xFFFFF0EF)
                              : const Color(0xFFEBFAF6),
                          child: Icon(
                            row['amount_paise'] is num &&
                                    (row['amount_paise'] as num) < 0
                                ? Icons.call_made
                                : Icons.call_received,
                            color: row['amount_paise'] is num &&
                                    (row['amount_paise'] as num) < 0
                                ? const Color(0xFFB3261E)
                                : const Color(0xFF056E57),
                          ),
                        ),
                        title: Text(ledgerTypeLabel(row['entry_type'])),
                        subtitle: Text([
                          ledgerNote(row),
                          if (row['entry_type'] == 'event_free_entry')
                            'Covered value ${rupees(row['cost_paise'])}',
                          '${row['created_at']}',
                        ].where((value) => value.isNotEmpty).join(' · ')),
                        trailing: Text(
                          row['entry_type'] == 'event_free_entry'
                              ? 'Free'
                              : '${Money.paise(row['amount_paise']) < 0 ? '− ' : '+ '}${rupees(Money.paise(row['amount_paise']).abs())}',
                          style: TextStyle(
                            fontWeight: FontWeight.w700,
                            color: Money.paise(row['amount_paise']) < 0
                                ? const Color(0xFFB3261E)
                                : const Color(0xFF16794A),
                          ),
                        ),
                      ),
                  ],
                ),
        ),
      ],
    );
  }
}

class _WalletAction {
  const _WalletAction(this.icon, this.label, this.onTap);
  final IconData icon;
  final String label;
  final Future<void> Function() onTap;
}

class _WalletActionButton extends StatelessWidget {
  const _WalletActionButton({required this.action, required this.vertical});

  final _WalletAction action;
  final bool vertical;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.symmetric(horizontal: vertical ? 0 : 3),
      child: vertical
          ? TextButton(
              onPressed: action.onTap,
              style: TextButton.styleFrom(
                alignment: Alignment.centerLeft,
                padding:
                    const EdgeInsets.symmetric(horizontal: 8, vertical: 10),
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12)),
              ),
              child: Row(
                children: [
                  Icon(action.icon, size: 21),
                  const SizedBox(width: 9),
                  Expanded(child: Text(action.label, maxLines: 2)),
                ],
              ),
            )
          : TextButton(
              onPressed: action.onTap,
              style: TextButton.styleFrom(
                padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 9),
                backgroundColor: const Color(0xFFF7F9FC),
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(14)),
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  CircleAvatar(
                    radius: 21,
                    backgroundColor: const Color(0xFFE7F0FF),
                    child: Icon(action.icon, color: const Color(0xFF245CAA)),
                  ),
                  const SizedBox(height: 4),
                  Text(action.label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 10)),
                ],
              ),
            ),
    );
  }
}

class StudentChatScreen extends StatefulWidget {
  const StudentChatScreen({
    required this.friend,
    required this.currentStudentId,
    required this.moneyFormatter,
    super.key,
  });

  final Map<String, dynamic> friend;
  final String currentStudentId;
  final String Function(dynamic) moneyFormatter;

  @override
  State<StudentChatScreen> createState() => _StudentChatScreenState();
}

class _StudentChatScreenState extends State<StudentChatScreen> {
  final messageController = TextEditingController();
  final scrollController = ScrollController();
  final amountController = TextEditingController();
  final noteController = TextEditingController();
  final pinController = TextEditingController();
  List<dynamic> messages = [];
  bool loading = true;
  bool sending = false;
  String? error;

  Future<void> loadMessages() async {
    try {
      final friendId = Uri.encodeComponent('${widget.friend['collegeId']}');
      final conversation = await api.get('/students/chat/$friendId');
      if (!mounted) return;
      setState(() {
        messages = conversation['messages'] as List<dynamic>? ?? [];
        error = null;
        loading = false;
      });
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (scrollController.hasClients) {
          scrollController.jumpTo(scrollController.position.maxScrollExtent);
        }
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        error = e.toString();
        loading = false;
      });
    }
  }

  Future<void> sendMessage() async {
    final message = messageController.text.trim();
    if (message.isEmpty || sending) return;
    setState(() {
      sending = true;
      error = null;
    });
    try {
      final saved = await api.post('/students/messages', {
        'collegeId': widget.friend['collegeId'],
        'message': message,
      });
      if (!mounted) return;
      messageController.clear();
      setState(() => messages = [
            ...messages,
            {'type': 'message', ...saved}
          ]);
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (scrollController.hasClients) {
          scrollController.animateTo(
            scrollController.position.maxScrollExtent,
            duration: const Duration(milliseconds: 180),
            curve: Curves.easeOut,
          );
        }
      });
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => sending = false);
    }
  }

  Future<void> sendMoney() async {
    amountController.clear();
    noteController.clear();
    pinController.clear();
    String? dialogError;
    var busy = false;
    Map<String, dynamic>? feeQuote;
    var transferRequestId = newRequestId();
    final sent = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (dialogContext, setDialogState) => AlertDialog(
          title: Text('Send money to ${widget.friend['name']}'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(
                  controller: amountController,
                  keyboardType:
                      const TextInputType.numberWithOptions(decimal: true),
                  decoration: const InputDecoration(labelText: 'Amount (₹)'),
                  onChanged: (_) => setDialogState(() {
                    feeQuote = null;
                    dialogError = null;
                    transferRequestId = newRequestId();
                  }),
                ),
                if (feeQuote != null) ...[
                  const SizedBox(height: 10),
                  Card(
                    color: const Color(0xFFEAF5F8),
                    child: Padding(
                      padding: const EdgeInsets.all(12),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text('Fee shown before confirmation',
                              style: TextStyle(fontWeight: FontWeight.w800)),
                          const SizedBox(height: 5),
                          Text(
                              'Transfer amount: ${widget.moneyFormatter(feeQuote!['amountPaise'])}'),
                          Text(
                              'Fee: ${widget.moneyFormatter(feeQuote!['feePaise'])}'),
                          Text(
                              'Total wallet debit: ${widget.moneyFormatter(feeQuote!['totalDebitPaise'])}',
                              style:
                                  const TextStyle(fontWeight: FontWeight.w700)),
                        ],
                      ),
                    ),
                  ),
                ],
                const SizedBox(height: 10),
                TextField(
                  controller: noteController,
                  maxLength: 100,
                  decoration:
                      const InputDecoration(labelText: 'Note (optional)'),
                ),
                const SizedBox(height: 10),
                TextField(
                  controller: pinController,
                  obscureText: true,
                  keyboardType: TextInputType.number,
                  decoration: const InputDecoration(
                      labelText: 'Confirm with wallet PIN'),
                ),
                if (dialogError != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 10),
                    child: Text(dialogError!,
                        style: const TextStyle(color: Colors.red)),
                  ),
              ],
            ),
          ),
          actions: [
            TextButton(
                onPressed:
                    busy ? null : () => Navigator.pop(dialogContext, false),
                child: const Text('Cancel')),
            FilledButton(
              onPressed: busy
                  ? null
                  : () async {
                      final rupeeAmount =
                          double.tryParse(amountController.text.trim());
                      final paise = rupeeAmount == null
                          ? null
                          : (rupeeAmount * 100).round();
                      if (rupeeAmount == null ||
                          !rupeeAmount.isFinite ||
                          paise == null ||
                          paise <= 0 ||
                          (rupeeAmount * 100 - paise).abs() > 0.000001) {
                        setDialogState(() =>
                            dialogError = 'Enter a valid amount in rupees.');
                        return;
                      }
                      setDialogState(() {
                        busy = true;
                        dialogError = null;
                      });
                      try {
                        if (feeQuote == null) {
                          final preview =
                              await api.post('/students/transfer/quote', {
                            'amountPaise': paise,
                          });
                          if (!dialogContext.mounted) return;
                          setDialogState(() {
                            feeQuote = preview;
                            busy = false;
                          });
                          return;
                        }
                        await api.post('/students/transfer', {
                          'collegeId': widget.friend['collegeId'],
                          'amountPaise': paise,
                          'note': noteController.text.trim(),
                          'pin': pinController.text,
                          'requestId': transferRequestId,
                        });
                        if (!dialogContext.mounted) return;
                        Navigator.pop(dialogContext, true);
                      } catch (e) {
                        setDialogState(() {
                          dialogError = e.toString();
                          busy = false;
                          pinController.clear();
                        });
                      }
                    },
              child: Text(busy
                  ? (feeQuote == null ? 'Checking fee…' : 'Sending…')
                  : (feeQuote == null ? 'Show fee' : 'Confirm send')),
            ),
          ],
        ),
      ),
    );
    if (sent == true) await loadMessages();
  }

  String _timeLabel(dynamic value) {
    final date = DateTime.tryParse('$value')?.toLocal();
    if (date == null) return '';
    final hour = date.hour % 12 == 0 ? 12 : date.hour % 12;
    final minute = date.minute.toString().padLeft(2, '0');
    return '$hour:$minute ${date.hour >= 12 ? 'PM' : 'AM'}';
  }

  Widget _messageTile(Map<String, dynamic> item) {
    if (item['type'] == 'payment') {
      final sent = item['direction'] == 'out';
      return Align(
        alignment: sent ? Alignment.centerRight : Alignment.centerLeft,
        child: Container(
          constraints: const BoxConstraints(maxWidth: 390),
          margin: const EdgeInsets.symmetric(vertical: 5),
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: const Color(0xFFF3FBF5),
            border: Border.all(color: const Color(0xFFDCEEE2)),
            borderRadius: BorderRadius.circular(15),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              const CircleAvatar(
                radius: 18,
                backgroundColor: Color(0xFFE6F6EB),
                child: Icon(Icons.check, color: Color(0xFF24884E)),
              ),
              const SizedBox(width: 10),
              Flexible(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '${sent ? 'Sent' : 'Received'} ${widget.moneyFormatter(item['amountPaise'])}',
                      style: const TextStyle(
                          fontWeight: FontWeight.w800,
                          color: Color(0xFF203A2B)),
                    ),
                    Text(
                      sent
                          ? 'Payment sent successfully'
                          : 'Payment received successfully',
                      style: const TextStyle(
                          fontSize: 11, color: Color(0xFF5C7967)),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Text(_timeLabel(item['createdAt']),
                  style:
                      const TextStyle(fontSize: 10, color: Color(0xFF8491A2))),
            ],
          ),
        ),
      );
    }
    final ownMessage = item['senderId'] == widget.currentStudentId;
    return Align(
      alignment: ownMessage ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        constraints:
            BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * 0.78),
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: const EdgeInsets.fromLTRB(13, 10, 13, 7),
        decoration: BoxDecoration(
          color: ownMessage ? const Color(0xFF28765B) : Colors.white,
          border: Border.all(
              color: ownMessage
                  ? const Color(0xFF28765B)
                  : const Color(0xFFE7EDF4)),
          borderRadius: BorderRadius.only(
            topLeft: const Radius.circular(16),
            topRight: const Radius.circular(16),
            bottomLeft: Radius.circular(ownMessage ? 16 : 5),
            bottomRight: Radius.circular(ownMessage ? 5 : 16),
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Align(
              alignment: Alignment.centerLeft,
              child: Text(
                '${item['body'] ?? ''}',
                style: TextStyle(
                    color: ownMessage ? Colors.white : const Color(0xFF26354C),
                    height: 1.4),
              ),
            ),
            const SizedBox(height: 3),
            Text(_timeLabel(item['createdAt']),
                style: TextStyle(
                    fontSize: 10,
                    color: ownMessage
                        ? const Color(0xFFD5EADF)
                        : const Color(0xFF8491A2))),
          ],
        ),
      ),
    );
  }

  @override
  void initState() {
    super.initState();
    loadMessages();
  }

  @override
  void dispose() {
    messageController.dispose();
    scrollController.dispose();
    amountController.dispose();
    noteController.dispose();
    pinController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final avatar = profilePhoto(widget.friend['photoData']);
    return Scaffold(
      appBar: AppBar(
        titleSpacing: 0,
        title: Row(
          children: [
            CircleAvatar(
              backgroundImage: avatar,
              child: avatar == null
                  ? Text(accountInitial(widget.friend['name']))
                  : null,
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('${widget.friend['name'] ?? 'Friend'}',
                      style: const TextStyle(fontSize: 16)),
                  Text('${widget.friend['collegeId'] ?? ''}',
                      style: const TextStyle(
                          fontSize: 11, fontWeight: FontWeight.w400)),
                ],
              ),
            ),
          ],
        ),
        actions: [
          TextButton.icon(
            onPressed: sendMoney,
            icon: const Icon(Icons.currency_rupee, size: 18),
            label: const Text('Pay'),
            style: TextButton.styleFrom(foregroundColor: Colors.white),
          ),
        ],
      ),
      body: Column(
        children: [
          if (error != null)
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(10),
              color: const Color(0xFFFFF0EF),
              child: Text(error!, style: const TextStyle(color: Colors.red)),
            ),
          Expanded(
            child: loading
                ? const Center(child: CircularProgressIndicator())
                : messages.isEmpty
                    ? Center(
                        child: Text(
                            'Say hello to ${widget.friend['name']} or send them money.'))
                    : ListView.builder(
                        controller: scrollController,
                        padding: const EdgeInsets.all(14),
                        itemCount: messages.length,
                        itemBuilder: (context, index) {
                          final item = messages[index];
                          return item is Map<String, dynamic>
                              ? _messageTile(item)
                              : const SizedBox.shrink();
                        },
                      ),
          ),
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 10),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Expanded(
                    child: TextField(
                      controller: messageController,
                      minLines: 1,
                      maxLines: 4,
                      maxLength: 1000,
                      textCapitalization: TextCapitalization.sentences,
                      decoration: const InputDecoration(
                        hintText: 'Write a message…',
                        counterText: '',
                        contentPadding:
                            EdgeInsets.symmetric(horizontal: 14, vertical: 11),
                      ),
                      onSubmitted: (_) => sendMessage(),
                    ),
                  ),
                  const SizedBox(width: 8),
                  IconButton.filled(
                    onPressed: sending ? null : sendMessage,
                    icon: sending
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(strokeWidth: 2))
                        : const Icon(Icons.send),
                  ),
                ],
              ),
            ),
          ),
          const Padding(
            padding: EdgeInsets.only(bottom: 8),
            child: Text('Wallet transfers are in local test mode.',
                style: TextStyle(fontSize: 10, color: Color(0xFF8491A2))),
          ),
        ],
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
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 460),
          child: ListView(
            padding: const EdgeInsets.all(20),
            children: [
              Text('Canteen',
                  style: Theme.of(context)
                      .textTheme
                      .headlineMedium
                      ?.copyWith(fontWeight: FontWeight.w800)),
              const SizedBox(height: 4),
              const Text('Sign in to collect campus payments.'),
              const SizedBox(height: 16),
              Card(
                margin: EdgeInsets.zero,
                child: Padding(
                  padding: const EdgeInsets.all(20),
                  child: Column(
                    children: [
                      TextField(
                          controller: collegeId,
                          decoration:
                              const InputDecoration(labelText: 'Canteen ID')),
                      const SizedBox(height: 12),
                      TextField(
                          controller: pin,
                          obscureText: true,
                          decoration: const InputDecoration(labelText: 'PIN')),
                      if (error != null)
                        Padding(
                          padding: const EdgeInsets.only(top: 12),
                          child: Text(error!,
                              style: const TextStyle(color: Colors.red)),
                        ),
                      const SizedBox(height: 16),
                      SizedBox(
                        width: double.infinity,
                        child: FilledButton(
                          onPressed: busy
                              ? null
                              : () async {
                                  setState(() => busy = true);
                                  try {
                                    final data =
                                        await api.post('/merchants/login', {
                                      'collegeId': collegeId.text.trim(),
                                      'pin': pin.text.trim(),
                                    });
                                    await api
                                        .saveToken(data['token'] as String);
                                    if (!context.mounted) return;
                                    Navigator.pushReplacement(
                                      context,
                                      MaterialPageRoute<void>(
                                          builder: (_) =>
                                              const MerchantHomeScreen()),
                                    );
                                  } catch (e) {
                                    if (!mounted) return;
                                    setState(() => error = e.toString());
                                  } finally {
                                    if (mounted) setState(() => busy = false);
                                  }
                                },
                          child: const Text('Log in'),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
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
      if (!mounted) return;
      setState(() {
        me = profile;
        ledger = book['entries'] as List<dynamic>? ?? [];
        error = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => error = e.toString());
    }
  }

  Future<void> charge() async {
    final rupeeValue = double.tryParse(rupees.text.trim());
    if (rupeeValue == null || rupeeValue <= 0) {
      if (!mounted) return;
      setState(() => error = 'Enter a rupee amount');
      return;
    }
    final paise = (rupeeValue * 100).round();
    try {
      await api.post('/merchants/charge', {
        'token': token.text.trim(),
        'amountPaise': paise,
        'paymentId': newRequestId(),
      });
      token.clear();
      await refresh();
    } catch (e) {
      if (!mounted) return;
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
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 28),
        children: [
          Container(
            padding: const EdgeInsets.all(20),
            decoration: BoxDecoration(
              gradient: const LinearGradient(
                  colors: [Color(0xFF173431), Color(0xFF056E57)]),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Sales balance',
                    style: TextStyle(color: Color(0xFFD7E7DF))),
                const SizedBox(height: 6),
                Text(
                  '₹${(Money.paise(me?['balancePaise']) / 100).toStringAsFixed(2)}',
                  style: Theme.of(context).textTheme.headlineMedium?.copyWith(
                      color: Colors.white, fontWeight: FontWeight.w800),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),
          Text('Collect a payment',
              style: Theme.of(context)
                  .textTheme
                  .titleLarge
                  ?.copyWith(fontWeight: FontWeight.w800)),
          const SizedBox(height: 8),
          Card(
            margin: EdgeInsets.zero,
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                children: [
                  if (error != null)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: Text(error!,
                          style: const TextStyle(color: Colors.red)),
                    ),
                  TextField(
                    controller: token,
                    decoration:
                        const InputDecoration(labelText: 'Student QR text'),
                    minLines: 2,
                    maxLines: 3,
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: rupees,
                    decoration: const InputDecoration(labelText: 'Charge (₹)'),
                    keyboardType:
                        const TextInputType.numberWithOptions(decimal: true),
                  ),
                  const SizedBox(height: 12),
                  SizedBox(
                      width: double.infinity,
                      child: FilledButton(
                          onPressed: charge, child: const Text('Charge'))),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),
          Text('Activity',
              style: Theme.of(context)
                  .textTheme
                  .titleLarge
                  ?.copyWith(fontWeight: FontWeight.w800)),
          const SizedBox(height: 8),
          Card(
            margin: EdgeInsets.zero,
            child: ledger.isEmpty
                ? const Padding(
                    padding: EdgeInsets.all(16), child: Text('No sales yet.'))
                : Column(
                    children: [
                      for (final row in ledger)
                        ListTile(
                          leading: const CircleAvatar(
                            backgroundColor: Color(0xFFEBFAF6),
                            child: Icon(Icons.receipt_long,
                                color: Color(0xFF056E57)),
                          ),
                          title: Text(ledgerTypeLabel(row['entry_type'])),
                          subtitle: Text(ledgerNote(row)),
                          trailing: Text(
                              '₹${(Money.paise(row['amount_paise']) / 100).toStringAsFixed(2)}'),
                        ),
                    ],
                  ),
          ),
        ],
      ),
    );
  }
}
