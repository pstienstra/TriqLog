// ============================================================
// TRIQLOG — Flutter Driver Dashboard
// State-driven visual interface: map, QR scan, 50/25/25 progress
// ============================================================

import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:geolocator/geolocator.dart';

// ─── App Entry ───────────────────────────────────────────────
void main() {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setSystemUIOverlayStyle(const SystemUiOverlayStyle(
    statusBarColor: Colors.transparent,
    statusBarIconBrightness: Brightness.light,
  ));
  runApp(const TriqLogApp());
}

class TriqLogApp extends StatelessWidget {
  const TriqLogApp({super.key});
  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'TriqLog — Driver',
    debugShowCheckedModeBanner: false,
    theme: ThemeData(
      scaffoldBackgroundColor: const Color(0xFF09090F),
      colorScheme: ColorScheme.dark(
        primary:    const Color(0xFFF0B429),
        secondary:  const Color(0xFF22C55E),
        surface:    const Color(0xFF181B28),
        background: const Color(0xFF09090F),
      ),
      fontFamily: 'Outfit',
    ),
    home: const DriverDashboard(),
  );
}

// ─── Enums & Models ──────────────────────────────────────────

enum ShipmentState {
  pendingPickup,    // Waiting at origin
  inTransit,        // Origin QR scanned, driving
  arrived,          // GPS ≤500m from destination
  t2Counting,       // 60-min hold running
  t2Released,       // 60-min passed, 25% released
  t3Holding,        // 24h or Net30/60 hold
  completed,        // Fully settled
}

class ActiveShipment {
  final String lotNumber;
  final String originCity;
  final String destinationCity;
  final LatLng originLatLng;
  final LatLng destinationLatLng;
  final double grossAmount;
  final double platformFee;
  final double netAmount;
  final double t1Amount;
  final double t2Amount;
  final double t3Amount;
  final bool   isCorporate;
  final int    paymentTermDays;
  ShipmentState state;
  DateTime?    t2HoldStart;
  DateTime?    t3HoldStart;
  bool         t1Released;
  bool         t2Released;
  bool         t3Released;
  bool         earlyReleaseAvailable;

  ActiveShipment({
    required this.lotNumber,
    required this.originCity,
    required this.destinationCity,
    required this.originLatLng,
    required this.destinationLatLng,
    required this.grossAmount,
    required this.platformFee,
    required this.netAmount,
    required this.t1Amount,
    required this.t2Amount,
    required this.t3Amount,
    this.isCorporate = false,
    this.paymentTermDays = 0,
    this.state = ShipmentState.pendingPickup,
    this.t1Released = false,
    this.t2Released = false,
    this.t3Released = false,
    this.t2HoldStart,
    this.t3HoldStart,
    this.earlyReleaseAvailable = false,
  });
}

// ─── DRIVER DASHBOARD ────────────────────────────────────────

class DriverDashboard extends StatefulWidget {
  const DriverDashboard({super.key});
  @override
  State<DriverDashboard> createState() => _DriverDashboardState();
}

class _DriverDashboardState extends State<DriverDashboard>
    with TickerProviderStateMixin {

  // Sample active shipment (would come from API in production)
  late ActiveShipment shipment;
  Timer?  _t2Timer;
  Timer?  _t3Timer;
  int     _t2SecondsLeft  = 0;
  int     _t3SecondsLeft  = 0;
  double  _driverLat      = 31.9241;
  double  _driverLng      = 6.3497;
  late AnimationController _pulseCtrl;
  late Animation<double>   _pulseAnim;
  GoogleMapController?     _mapCtrl;

  @override
  void initState() {
    super.initState();
    _initShipment();
    _initAnimations();
  }

  void _initShipment() {
    shipment = ActiveShipment(
      lotNumber:          'LOT-8821',
      originCity:         'Béni Mellal',
      destinationCity:    'Casablanca',
      originLatLng:       const LatLng(32.3373, -6.3498),
      destinationLatLng:  const LatLng(33.5731, -7.5898),
      grossAmount:        7000,
      platformFee:        210,
      netAmount:          6790,
      t1Amount:           3395,
      t2Amount:           1698,
      t3Amount:           1697,
      isCorporate:        false,
      state:              ShipmentState.inTransit,
      t1Released:         true,
      t2HoldStart:        DateTime.now().subtract(const Duration(minutes: 17)),
    );
    // T2 is currently counting
    _startT2Timer();
  }

  void _initAnimations() {
    _pulseCtrl = AnimationController(
      vsync:    this,
      duration: const Duration(milliseconds: 1400),
    )..repeat(reverse: true);
    _pulseAnim = Tween<double>(begin: 0.9, end: 1.08).animate(
      CurvedAnimation(parent: _pulseCtrl, curve: Curves.easeInOut),
    );
  }

  void _startT2Timer() {
    const holdMins = 60;
    final elapsed  = DateTime.now().difference(shipment.t2HoldStart!).inSeconds;
    _t2SecondsLeft = (holdMins * 60) - elapsed;
    if (_t2SecondsLeft <= 0) { _onT2Released(); return; }

    _t2Timer = Timer.periodic(const Duration(seconds: 1), (t) {
      setState(() { _t2SecondsLeft--; });
      if (_t2SecondsLeft <= 0) { t.cancel(); _onT2Released(); }
    });
  }

  void _onT2Released() {
    setState(() {
      shipment.t2Released = true;
      shipment.state      = ShipmentState.t2Released;
      shipment.t3HoldStart = DateTime.now();
      if (shipment.isCorporate) {
        _t3SecondsLeft = shipment.paymentTermDays * 24 * 3600;
      } else {
        _t3SecondsLeft = 24 * 3600;
        shipment.earlyReleaseAvailable = false;  // 24h auto-release, no early option
      }
    });
    _showReleaseSnack('✅ MAD ${shipment.t2Amount.toStringAsFixed(0)} libéré !', Colors.green);
    _startT3Timer();
  }

  void _startT3Timer() {
    if (!shipment.isCorporate) {
      // Informal: 24h auto
      _t3Timer = Timer.periodic(const Duration(seconds: 1), (t) {
        setState(() { _t3SecondsLeft--; });
        if (_t3SecondsLeft <= 0) { t.cancel(); _onT3Released(); }
      });
    } else {
      // Corporate: show countdown but allow early release
      setState(() { shipment.earlyReleaseAvailable = true; });
      _t3Timer = Timer.periodic(const Duration(seconds: 1), (t) {
        setState(() { _t3SecondsLeft--; });
        if (_t3SecondsLeft <= 0) { t.cancel(); _onT3Released(); }
      });
    }
  }

  void _onT3Released() {
    setState(() {
      shipment.t3Released = true;
      shipment.state      = ShipmentState.completed;
      shipment.earlyReleaseAvailable = false;
    });
    _showReleaseSnack('🎉 Voyage terminé ! MAD ${shipment.netAmount.toStringAsFixed(0)} net total', Colors.amber);
  }

  void _onOriginQRScanned(String code, double lat, double lng, double accuracy) {
    if (shipment.state != ShipmentState.pendingPickup) return;
    setState(() {
      shipment.t1Released  = true;
      shipment.state       = ShipmentState.inTransit;
      shipment.t2HoldStart = null;
    });
    _showReleaseSnack('💰 MAD ${shipment.t1Amount.toStringAsFixed(0)} versés ! 📍${lat.toStringAsFixed(5)},${lng.toStringAsFixed(5)}', Colors.amber);
  }

  void _onDestinationQRScanned(String code, double lat, double lng, double accuracy) {
    if (shipment.state != ShipmentState.arrived &&
        shipment.state != ShipmentState.inTransit) return;
    setState(() {
      shipment.state       = ShipmentState.t2Counting;
      shipment.t2HoldStart = DateTime.now();
      _t2SecondsLeft       = 60 * 60;
    });
    _startT2Timer();
    _showReleaseSnack('📍 Arrivée GPS confirmée (±${accuracy.toStringAsFixed(0)}m) · Minuteur 60 min démarré.', Colors.blue);
  }

  void _requestEarlyRelease() {
    showModalBottomSheet(
      context:       context,
      backgroundColor: const Color(0xFF1E2235),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (_) => _EarlyReleaseSheet(
        t3Amount:      shipment.t3Amount,
        onConfirm: () {
          Navigator.pop(context);
          _onT3Released();
          _t3Timer?.cancel();
        },
      ),
    );
  }

  void _showReleaseSnack(String msg, Color color) {
    HapticFeedback.heavyImpact();
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(msg, style: const TextStyle(fontWeight: FontWeight.w800)),
      backgroundColor: color,
      duration: const Duration(seconds: 4),
    ));
  }

  String _formatTimer(int secs) {
    final h = (secs ~/ 3600).toString().padLeft(2, '0');
    final m = ((secs % 3600) ~/ 60).toString().padLeft(2, '0');
    final s = (secs % 60).toString().padLeft(2, '0');
    return '$h:$m:$s';
  }

  @override
  void dispose() {
    _t2Timer?.cancel();
    _t3Timer?.cancel();
    _pulseCtrl.dispose();
    super.dispose();
  }

  // ─── BUILD ─────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) => Scaffold(
    body: Stack(children: [
      // MAP
      _buildMap(),
      // BOTTOM PANEL
      Positioned(
        left: 0, right: 0, bottom: 0,
        child: _buildBottomPanel(),
      ),
      // TOP STATUS BAR
      Positioned(
        top: MediaQuery.of(context).padding.top + 8,
        left: 12, right: 12,
        child: _buildTopBar(),
      ),
    ]),
  );

  // ─── MAP ───────────────────────────────────────────────────

  Widget _buildMap() => GoogleMap(
    initialCameraPosition: CameraPosition(
      target: LatLng(
        (shipment.originLatLng.latitude  + shipment.destinationLatLng.latitude)  / 2,
        (shipment.originLatLng.longitude + shipment.destinationLatLng.longitude) / 2,
      ),
      zoom: 7.5,
    ),
    onMapCreated: (ctrl) => _mapCtrl = ctrl,
    mapType: MapType.normal,
    zoomControlsEnabled: false,
    myLocationButtonEnabled: false,
    markers: {
      Marker(
        markerId: const MarkerId('origin'),
        position: shipment.originLatLng,
        icon: BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueGreen),
        infoWindow: InfoWindow(title: shipment.originCity),
      ),
      Marker(
        markerId: const MarkerId('dest'),
        position: shipment.destinationLatLng,
        icon: BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueRed),
        infoWindow: InfoWindow(title: shipment.destinationCity),
      ),
      Marker(
        markerId: const MarkerId('truck'),
        position: LatLng(_driverLat, _driverLng),
        icon: BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueOrange),
        infoWindow: const InfoWindow(title: '🚛 Votre position'),
      ),
    },
    polylines: {
      Polyline(
        polylineId: const PolylineId('route'),
        points: [shipment.originLatLng, LatLng(_driverLat, _driverLng), shipment.destinationLatLng],
        color: const Color(0xFFF0B429),
        width: 4,
        patterns: [PatternItem.dash(20), PatternItem.gap(8)],
      ),
    },
  );

  // ─── TOP BAR ───────────────────────────────────────────────

  Widget _buildTopBar() => Container(
    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
    decoration: BoxDecoration(
      color: const Color(0xFF181B28).withOpacity(0.95),
      borderRadius: BorderRadius.circular(16),
      border: Border.all(color: Colors.white12),
      boxShadow: [BoxShadow(color: Colors.black45, blurRadius: 12)],
    ),
    child: Row(
      children: [
        Container(
          width: 38, height: 38, decoration: BoxDecoration(
            gradient: const LinearGradient(colors: [Color(0xFFF0B429), Color(0xFFB07010)]),
            borderRadius: BorderRadius.circular(10),
          ),
          child: const Center(child: Text('🚛', style: TextStyle(fontSize: 18))),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(shipment.lotNumber, style: const TextStyle(
                fontWeight: FontWeight.w900, fontSize: 15, color: Colors.white,
              )),
              Text(
                '${shipment.originCity}  →  ${shipment.destinationCity}',
                style: TextStyle(fontSize: 12, color: Colors.white54,
                  fontFamily: 'IBMPlexMono'),
              ),
            ],
          ),
        ),
        _buildStatusChip(),
      ],
    ),
  );

  Widget _buildStatusChip() {
    final (label, color) = switch (shipment.state) {
      ShipmentState.pendingPickup => ('ATTENTE', Colors.grey),
      ShipmentState.inTransit    => ('EN ROUTE', const Color(0xFFF0B429)),
      ShipmentState.arrived      => ('ARRIVÉ', Colors.blue),
      ShipmentState.t2Counting   => ('60 MIN', const Color(0xFFF0B429)),
      ShipmentState.t2Released   => ('T2 ✓', Colors.green),
      ShipmentState.t3Holding    => ('EN ATTENTE', Colors.purple),
      ShipmentState.completed    => ('TERMINÉ ✓', Colors.green),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color:        color.withOpacity(0.15),
        borderRadius: BorderRadius.circular(100),
        border:       Border.all(color: color.withOpacity(0.4)),
      ),
      child: Text(label, style: TextStyle(
        color: color, fontSize: 10, fontWeight: FontWeight.w800,
        fontFamily: 'IBMPlexMono', letterSpacing: 0.5,
      )),
    );
  }

  // ─── BOTTOM PANEL ─────────────────────────────────────────

  Widget _buildBottomPanel() => Container(
    decoration: BoxDecoration(
      color: const Color(0xFF181B28),
      borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
      border: const Border(top: BorderSide(color: Colors.white12)),
      boxShadow: [BoxShadow(color: Colors.black54, blurRadius: 24, offset: const Offset(0, -4))],
    ),
    child: Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        // Handle
        Container(
          margin: const EdgeInsets.symmetric(vertical: 10),
          width: 40, height: 4,
          decoration: BoxDecoration(
            color: Colors.white24,
            borderRadius: BorderRadius.circular(2),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
          child: Column(
            children: [
              // 50/25/25 Progress bar
              _buildPaymentProgress(),
              const SizedBox(height: 16),
              // Countdown / Hold display
              if (shipment.state == ShipmentState.t2Counting) _buildT2Countdown(),
              if (shipment.state == ShipmentState.t3Holding  ||
                  shipment.state == ShipmentState.t2Released) _buildT3Hold(),
              const SizedBox(height: 12),
              // BIG ACTION BUTTON
              _buildActionButton(),
              const SizedBox(height: 16),
            ],
          ),
        ),
        SizedBox(height: MediaQuery.of(context).padding.bottom),
      ],
    ),
  );

  // ─── PAYMENT PROGRESS BAR ─────────────────────────────────

  Widget _buildPaymentProgress() => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text('Paiement', style: TextStyle(
            color: Colors.white54, fontSize: 11, fontFamily: 'IBMPlexMono',
            fontWeight: FontWeight.w600, letterSpacing: 0.8,
          )),
          Text('Net MAD ${shipment.netAmount.toStringAsFixed(0)}',
            style: const TextStyle(
              color: Color(0xFF22C55E), fontSize: 12,
              fontWeight: FontWeight.w800, fontFamily: 'IBMPlexMono',
            )),
        ],
      ),
      const SizedBox(height: 10),
      // Progress track
      SizedBox(
        height: 56,
        child: Stack(
          children: [
            // Background track
            Positioned(
              top: 20, left: 0, right: 0, height: 8,
              child: Container(
                decoration: BoxDecoration(
                  color: Colors.white10,
                  borderRadius: BorderRadius.circular(4),
                ),
              ),
            ),
            // Milestone markers
            _buildMilestone(
              position: 0,
              label:    '50%',
              amount:   'MAD ${shipment.t1Amount.toStringAsFixed(0)}',
              sublabel: 'À la prise',
              released: shipment.t1Released,
              color:    const Color(0xFF22C55E),
            ),
            _buildMilestone(
              position: 0.5,
              label:    '25%',
              amount:   'MAD ${shipment.t2Amount.toStringAsFixed(0)}',
              sublabel: '60 min GPS',
              released: shipment.t2Released,
              color:    const Color(0xFFF0B429),
              counting: shipment.state == ShipmentState.t2Counting,
            ),
            _buildMilestone(
              position: 1.0,
              label:    '25%',
              amount:   'MAD ${shipment.t3Amount.toStringAsFixed(0)}',
              sublabel: shipment.isCorporate ? 'Net ${shipment.paymentTermDays}j' : '24h',
              released: shipment.t3Released,
              color:    const Color(0xFFC084FC),
              isLast:   true,
            ),
          ],
        ),
      ),
    ],
  );

  Widget _buildMilestone({
    required double position,
    required String label,
    required String amount,
    required String sublabel,
    required bool released,
    required Color color,
    bool counting = false,
    bool isLast   = false,
  }) {
    return LayoutBuilder(
      builder: (ctx, constraints) {
        final x = constraints.maxWidth * position;
        return Positioned(
          left: isLast ? null : x - 24,
          right: isLast ? 0 : null,
          top:   0,
          width: 48,
          child: Column(
            children: [
              // Coin / milestone icon
              ScaleTransition(
                scale: counting ? _pulseAnim : const AlwaysStoppedAnimation(1.0),
                child: Container(
                  width: 40, height: 40,
                  decoration: BoxDecoration(
                    shape:     BoxShape.circle,
                    color:     released ? color : color.withOpacity(0.15),
                    border:    Border.all(
                      color: released || counting ? color : color.withOpacity(0.3),
                      width: counting ? 2.5 : 1.5,
                    ),
                    boxShadow: (released || counting) ? [
                      BoxShadow(color: color.withOpacity(0.4), blurRadius: 12),
                    ] : [],
                  ),
                  child: Center(
                    child: Text(
                      released ? '✓' : (counting ? '⏱' : label),
                      style: TextStyle(
                        fontSize:   released ? 16 : 10,
                        color:      released || counting ? Colors.white : color,
                        fontWeight: FontWeight.w900,
                      ),
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 4),
              Text(amount, style: TextStyle(
                fontSize: 9, color: released ? color : Colors.white38,
                fontWeight: FontWeight.w800, fontFamily: 'IBMPlexMono',
              )),
            ],
          ),
        );
      },
    );
  }

  // ─── T2 COUNTDOWN ─────────────────────────────────────────

  Widget _buildT2Countdown() => Container(
    padding: const EdgeInsets.all(14),
    decoration: BoxDecoration(
      color:        const Color(0xFFF0B429).withOpacity(0.08),
      borderRadius: BorderRadius.circular(12),
      border:       Border.all(color: const Color(0xFFF0B429).withOpacity(0.25)),
    ),
    child: Row(
      children: [
        // Animated gold coin
        ScaleTransition(
          scale: _pulseAnim,
          child: const Text('🪙', style: TextStyle(fontSize: 32)),
        ),
        const SizedBox(width: 14),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('Fenêtre de 60 minutes',
                style: TextStyle(fontSize: 12, fontWeight: FontWeight.w800,
                  color: Color(0xFFF0B429))),
              const SizedBox(height: 3),
              Text('MAD ${shipment.t2Amount.toStringAsFixed(0)} libéré à expiration',
                style: const TextStyle(fontSize: 11, color: Colors.white54)),
            ],
          ),
        ),
        Text(
          _formatTimer(_t2SecondsLeft),
          style: const TextStyle(
            fontSize: 20, fontWeight: FontWeight.w900,
            color: Color(0xFFF0B429), fontFamily: 'IBMPlexMono',
            letterSpacing: 2,
          ),
        ),
      ],
    ),
  );

  // ─── T3 HOLD DISPLAY ──────────────────────────────────────

  Widget _buildT3Hold() => Container(
    padding: const EdgeInsets.all(14),
    decoration: BoxDecoration(
      color:        const Color(0xFFC084FC).withOpacity(0.07),
      borderRadius: BorderRadius.circular(12),
      border:       Border.all(color: const Color(0xFFC084FC).withOpacity(0.2)),
    ),
    child: Column(
      children: [
        Row(
          children: [
            const Text('🔒', style: TextStyle(fontSize: 24)),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    shipment.isCorporate
                      ? 'Règlement corporate J+${shipment.paymentTermDays}'
                      : 'Fenêtre 24h anti-fraude',
                    style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w800,
                      color: Color(0xFFC084FC)),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    'MAD ${shipment.t3Amount.toStringAsFixed(0)} · ${_formatTimer(_t3SecondsLeft)} restant',
                    style: const TextStyle(fontSize: 11, color: Colors.white54,
                      fontFamily: 'IBMPlexMono'),
                  ),
                ],
              ),
            ),
          ],
        ),
        if (shipment.isCorporate && shipment.earlyReleaseAvailable) ...[
          const SizedBox(height: 10),
          GestureDetector(
            onTap: _requestEarlyRelease,
            child: Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(vertical: 10),
              decoration: BoxDecoration(
                gradient: const LinearGradient(
                  colors: [Color(0xFF2DD4BF), Color(0xFF1A9E8A)],
                ),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Text('⚡', style: TextStyle(fontSize: 16)),
                  const SizedBox(width: 6),
                  Text(
                    'Early Release — MAD ${(shipment.t3Amount * 0.95).toStringAsFixed(0)} maintenant (−5%)',
                    style: const TextStyle(
                      color: Color(0xFF021410), fontSize: 12,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ],
    ),
  );

  // ─── BIG ACTION BUTTON ────────────────────────────────────

  Widget _buildActionButton() {
    if (shipment.state == ShipmentState.completed) {
      return _GreenButton(
        label:    '🎉 Voyage terminé — Voir le reçu',
        onTap:    () {},
        color:    const Color(0xFF22C55E),
        icon:     '',
      );
    }

    if (shipment.state == ShipmentState.t2Counting ||
        shipment.state == ShipmentState.t3Holding  ||
        shipment.state == ShipmentState.t2Released) {
      // Waiting — show greyed out
      return _GreenButton(
        label:    'Minuteur en cours…',
        onTap:    () {},
        color:    Colors.white24,
        enabled:  false,
        icon:     '⏳',
      );
    }

    if (shipment.state == ShipmentState.inTransit ||
        shipment.state == ShipmentState.arrived) {
      return _GreenButton(
        label:    'Scanner QR de livraison',
        onTap:    _openQRScanner,
        color:    const Color(0xFF22C55E),
        icon:     '📷',
      );
    }

    // Pending pickup
    return _GreenButton(
      label:    'Scanner QR de prise en charge',
      onTap:    _openQRScanner,
      color:    const Color(0xFFF0B429),
      icon:     '📷',
    );
  }

  void _openQRScanner() {
    Navigator.push(context, MaterialPageRoute(
      builder: (_) => QRScannerScreen(
        onScanned: (result) {
          Navigator.pop(context);
          if (shipment.state == ShipmentState.pendingPickup) {
            _onOriginQRScanned(result.qrPayload, result.lat, result.lng, result.gpsAccuracyMetres);
          } else {
            _onDestinationQRScanned(result.qrPayload, result.lat, result.lng, result.gpsAccuracyMetres);
          }
        },
      ),
    ));
  }
}

// ─── Reusable Green Button ────────────────────────────────────

class _GreenButton extends StatelessWidget {
  final String label;
  final VoidCallback onTap;
  final Color color;
  final String icon;
  final bool enabled;

  const _GreenButton({
    required this.label,
    required this.onTap,
    required this.color,
    this.icon    = '',
    this.enabled = true,
  });

  @override
  Widget build(BuildContext context) => GestureDetector(
    onTap: enabled ? onTap : null,
    child: Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(vertical: 18),
      decoration: BoxDecoration(
        gradient: enabled ? LinearGradient(
          colors: [color, color.withOpacity(0.8)],
        ) : null,
        color:        enabled ? null : color,
        borderRadius: BorderRadius.circular(14),
        boxShadow: enabled ? [
          BoxShadow(color: color.withOpacity(0.35), blurRadius: 16, offset: const Offset(0, 6)),
        ] : [],
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          if (icon.isNotEmpty) ...[
            Text(icon, style: const TextStyle(fontSize: 22)),
            const SizedBox(width: 10),
          ],
          Text(label, style: TextStyle(
            color:       enabled ? const Color(0xFF021008) : Colors.white38,
            fontSize:    16,
            fontWeight:  FontWeight.w900,
            letterSpacing: 0.2,
          )),
        ],
      ),
    ),
  );
}

// ─── Early Release Bottom Sheet ───────────────────────────────

class _EarlyReleaseSheet extends StatelessWidget {
  final double t3Amount;
  final VoidCallback onConfirm;
  const _EarlyReleaseSheet({required this.t3Amount, required this.onConfirm});

  @override
  Widget build(BuildContext context) {
    final fee    = (t3Amount * 0.05).toStringAsFixed(2);
    final net    = (t3Amount * 0.95).toStringAsFixed(2);

    return Padding(
      padding: EdgeInsets.fromLTRB(20, 20, 20, MediaQuery.of(context).padding.bottom + 20),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Text('⚡', style: TextStyle(fontSize: 44)),
          const SizedBox(height: 12),
          const Text('Early Release',
            style: TextStyle(fontSize: 22, fontWeight: FontWeight.w900, color: Color(0xFF2DD4BF))),
          const SizedBox(height: 6),
          Text('Recevez votre paiement maintenant au lieu d\'attendre',
            style: TextStyle(fontSize: 13, color: Colors.white54),
            textAlign: TextAlign.center),
          const SizedBox(height: 20),
          _calcRow('Tranche 3',      'MAD ${t3Amount.toStringAsFixed(2)}'),
          _calcRow('Frais −5%',      '−MAD $fee', red: true),
          const Divider(color: Colors.white12),
          _calcRow('Vous recevez',   'MAD $net',   bold: true, color: const Color(0xFF2DD4BF)),
          const SizedBox(height: 20),
          GestureDetector(
            onTap: onConfirm,
            child: Container(
              width: double.infinity, padding: const EdgeInsets.symmetric(vertical: 16),
              decoration: BoxDecoration(
                gradient: const LinearGradient(colors: [Color(0xFF2DD4BF), Color(0xFF1A9E8A)]),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Text('Confirmer — Recevoir MAD $net maintenant',
                textAlign: TextAlign.center,
                style: const TextStyle(color: Color(0xFF021410), fontSize: 14, fontWeight: FontWeight.w900)),
            ),
          ),
          const SizedBox(height: 10),
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Annuler — Attendre le règlement normal',
              style: TextStyle(color: Colors.white38, fontSize: 12)),
          ),
        ],
      ),
    );
  }

  Widget _calcRow(String label, String value, {bool bold = false, bool red = false, Color? color}) =>
    Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: TextStyle(fontSize: 13, color: Colors.white54)),
          Text(value,  style: TextStyle(
            fontSize:   13,
            fontWeight: bold ? FontWeight.w800 : FontWeight.w600,
            color:      color ?? (red ? const Color(0xFFEF4444) : Colors.white),
            fontFamily: 'IBMPlexMono',
          )),
        ],
      ),
    );
}

// ─── QR Scanner Screen ────────────────────────────────────────

// ─── GPS-Stamped QR Scanner ───────────────────────────────────
// Grabs high-accuracy GPS simultaneously with QR scan.
// Both are sent together to the backend — GPS is captured at the
// exact moment of scan, not before or after.
// The server generates the legally binding timestamp — the client
// timestamp is never trusted.

class QRScanResult {
  final String  qrPayload;
  final double  lat;
  final double  lng;
  final double  gpsAccuracyMetres;

  const QRScanResult({
    required this.qrPayload,
    required this.lat,
    required this.lng,
    required this.gpsAccuracyMetres,
  });
}

class QRScannerScreen extends StatefulWidget {
  final ValueChanged<QRScanResult> onScanned;
  const QRScannerScreen({super.key, required this.onScanned});

  @override
  State<QRScannerScreen> createState() => _QRScannerScreenState();
}

class _QRScannerScreenState extends State<QRScannerScreen> {
  bool _scanning    = true;
  bool _gpsLoading  = false;
  String _statusMsg = 'Pointez vers le QR code du chargement';

  // Grab GPS the moment a QR code is detected
  Future<void> _handleDetect(BarcodeCapture capture) async {
    if (!_scanning) return;
    final barcode = capture.barcodes.firstOrNull;
    if (barcode?.rawValue == null) return;

    setState(() {
      _scanning   = false;
      _gpsLoading = true;
      _statusMsg  = '📍 Verrouillage GPS en cours…';
    });

    HapticFeedback.mediumImpact();

    try {
      // Request high-accuracy GPS simultaneously
      // timeLimit ensures we don't block the UX for more than 8 seconds
      final position = await Geolocator.getCurrentPosition(
        desiredAccuracy: LocationAccuracy.high,
        timeLimit:       const Duration(seconds: 8),
      );

      if (!mounted) return;

      final result = QRScanResult(
        qrPayload:          barcode!.rawValue!,
        lat:                position.latitude,
        lng:                position.longitude,
        gpsAccuracyMetres:  position.accuracy,
      );

      Navigator.pop(context);
      widget.onScanned(result);

    } catch (e) {
      // GPS failed — show error, allow retry
      setState(() {
        _scanning   = true;
        _gpsLoading = false;
        _statusMsg  = '⚠️ GPS indisponible — activez la localisation et réessayez';
      });
      HapticFeedback.heavyImpact();
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    backgroundColor: Colors.black,
    appBar: AppBar(
      backgroundColor: const Color(0xFF181B28),
      title: const Text('Scanner le QR code', style: TextStyle(fontWeight: FontWeight.w800)),
      leading: IconButton(
        icon: const Icon(Icons.arrow_back_ios_rounded),
        onPressed: () => Navigator.pop(context),
      ),
    ),
    body: Stack(children: [

      // Camera
      MobileScanner(
        onDetect: _handleDetect,
      ),

      // Scan frame
      Center(
        child: Container(
          width: 240, height: 240,
          decoration: BoxDecoration(
            border: Border.all(
              color: _gpsLoading
                ? const Color(0xFF60A5FA)   // Blue when locking GPS
                : const Color(0xFFF0B429),  // Amber when scanning QR
              width: 3,
            ),
            borderRadius: BorderRadius.circular(16),
          ),
        ),
      ),

      // GPS loading indicator
      if (_gpsLoading)
        Center(
          child: Container(
            margin: const EdgeInsets.only(top: 280),
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
            decoration: BoxDecoration(
              color: const Color(0xFF181B28).withOpacity(0.95),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: const Color(0xFF60A5FA).withOpacity(0.4)),
            ),
            child: const Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                SizedBox(
                  width: 16, height: 16,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: Color(0xFF60A5FA),
                  ),
                ),
                SizedBox(width: 10),
                Text(
                  'Verrouillage GPS…',
                  style: TextStyle(color: Color(0xFF60A5FA), fontSize: 13, fontWeight: FontWeight.w700),
                ),
              ],
            ),
          ),
        ),

      // Status message
      Positioned(
        bottom: 60, left: 0, right: 0,
        child: Text(
          _statusMsg,
          textAlign: TextAlign.center,
          style: TextStyle(
            color: _gpsLoading ? const Color(0xFF60A5FA) : Colors.white70,
            fontSize: 13,
            fontWeight: FontWeight.w600,
          ),
        ),
      ),

      // GPS accuracy badge (shown while loading)
      Positioned(
        top: 16, right: 16,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
          decoration: BoxDecoration(
            color: const Color(0xFF181B28).withOpacity(0.85),
            borderRadius: BorderRadius.circular(8),
          ),
          child: const Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.gps_fixed, size: 12, color: Color(0xFF60A5FA)),
              SizedBox(width: 5),
              Text('GPS Haute Précision', style: TextStyle(color: Color(0xFF60A5FA), fontSize: 10, fontWeight: FontWeight.w700)),
            ],
          ),
        ),
      ),

    ]),
  );
}

