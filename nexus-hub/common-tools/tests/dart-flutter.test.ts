// ─────────────────────────────────────────────────────────────
// Dart / Flutter support — integration tests
// Covers: language detection, symbol extraction, class hierarchy,
//         and Firebase infra-pattern detection.
// ─────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll } from "vitest";
import { CodeParser } from "../src/universal-parser.js";

let parser: CodeParser;

beforeAll(() => {
  parser = new CodeParser();
});

// ─────────────────────────────────────────────────────────────
// Language detection
// ─────────────────────────────────────────────────────────────

describe("CodeParser.detectLanguage — Dart", () => {
  it("detects .dart → dart", () => {
    expect(parser.detectLanguage("main.dart")).toBe("dart");
    expect(parser.detectLanguage("lib/services/auth_service.dart")).toBe(
      "dart",
    );
  });
});

// ─────────────────────────────────────────────────────────────
// Symbol extraction
// ─────────────────────────────────────────────────────────────

describe("CodeParser.parseSource — Dart functions", () => {
  const source = `
/// Fetches a user by ID from the remote API.
Future<User> fetchUser(String userId, {bool cached = false}) async {
  final data = await http.get(Uri.parse('/users/\$userId'));
  return User.fromJson(data);
}

String formatName(String first, String last) {
  return '\$first \$last';
}
`;

  it("detects language as dart", async () => {
    const result = await parser.parseSource("user.dart", source);
    expect(result.language).toBe("dart");
    expect(result.parseErrors).toEqual([]);
  });

  it("extracts top-level functions", async () => {
    const result = await parser.parseSource("user.dart", source);
    const names = result.symbols.map((s) => s.name);
    expect(names).toContain("fetchUser");
    expect(names).toContain("formatName");
  });

  it("extracts function params", async () => {
    const result = await parser.parseSource("user.dart", source);
    const fn = result.symbols.find((s) => s.name === "formatName");
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe("function");
    expect(fn!.params.length).toBe(2);
    expect(fn!.params[0].name).toBe("first");
    expect(fn!.params[1].name).toBe("last");
  });

  it("captures docstring on functions", async () => {
    const result = await parser.parseSource("user.dart", source);
    const fn = result.symbols.find((s) => s.name === "fetchUser");
    expect(fn!.docstring).toContain("Fetches a user");
  });
});

describe("CodeParser.parseSource — Dart classes", () => {
  const source = `
/// Base widget for all screens.
abstract class BaseScreen extends StatefulWidget {
  const BaseScreen({super.key});
}

class HomeScreen extends BaseScreen with NavigationMixin implements Trackable {
  @override
  State<HomeScreen> createState() => _HomeScreenState();

  void _onTap(String route) {
    navigate(route);
  }
}
`;

  it("extracts class names", async () => {
    const result = await parser.parseSource("home.dart", source);
    const classNames = result.classes.map((c) => c.name);
    expect(classNames).toContain("BaseScreen");
    expect(classNames).toContain("HomeScreen");
  });

  it("captures extends / implements / with (mixins)", async () => {
    const result = await parser.parseSource("home.dart", source);
    const home = result.classes.find((c) => c.name === "HomeScreen");
    expect(home).toBeDefined();
    expect(home!.bases).toContain("BaseScreen");
    expect(home!.bases).toContain("NavigationMixin");
    expect(home!.bases).toContain("Trackable");
  });

  it("lists methods of a class", async () => {
    const result = await parser.parseSource("home.dart", source);
    const home = result.classes.find((c) => c.name === "HomeScreen");
    expect(home!.methods).toContain("createState");
    expect(home!.methods).toContain("_onTap");
  });

  it("captures docstring on abstract class", async () => {
    const result = await parser.parseSource("home.dart", source);
    const base = result.classes.find((c) => c.name === "BaseScreen");
    expect(base!.docstring).toContain("Base widget");
  });
});

describe("CodeParser.parseSource — Dart method calls", () => {
  const source = `
class AuthService {
  Future<void> login(String email, String password) async {
    final user = await signIn(email, password);
    saveSession(user);
  }

  void logout() {
    clearSession();
    redirectToLogin();
  }
}
`;

  it("extracts calls inside method bodies", async () => {
    const result = await parser.parseSource("auth.dart", source);
    const login = result.symbols.find((s) => s.name === "login");
    expect(login).toBeDefined();
    const callNames = login!.calls.map((c) => c.name);
    expect(callNames).toContain("signIn");
    expect(callNames).toContain("saveSession");
  });
});

// ─────────────────────────────────────────────────────────────
// Firebase infra-pattern detection
// ─────────────────────────────────────────────────────────────

describe("Infrastructure Detection — Firebase Firestore", () => {
  it("detects FirebaseFirestore.instance initialisation", async () => {
    const source = `
void setup() {
  final db = FirebaseFirestore.instance;
}
`;
    const result = await parser.parseSource("db.dart", source);
    const p = result.infraPatterns.find((p) => p.kind === "firebase_firestore");
    expect(p).toBeDefined();
  });

  it("detects .collection() call with target", async () => {
    const source = `
Future<void> loadUsers() async {
  final snap = await FirebaseFirestore.instance.collection('users').get();
}
`;
    const result = await parser.parseSource("users.dart", source);
    const p = result.infraPatterns.find(
      (p) => p.kind === "firebase_firestore" && p.target === "users",
    );
    expect(p).toBeDefined();
    expect(p!.detail).toContain("users");
  });

  it("detects .doc() call", async () => {
    const source = `
void getUser(String id) {
  db.collection('users').doc(id);
}
`;
    const result = await parser.parseSource("repo.dart", source);
    const patterns = result.infraPatterns.filter(
      (p) => p.kind === "firebase_firestore",
    );
    expect(patterns.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Infrastructure Detection — Firebase Auth", () => {
  it("detects FirebaseAuth.instance", async () => {
    const source = `
void initAuth() {
  final auth = FirebaseAuth.instance;
}
`;
    const result = await parser.parseSource("auth.dart", source);
    const p = result.infraPatterns.find((p) => p.kind === "firebase_auth");
    expect(p).toBeDefined();
  });

  it("detects signInWithEmailAndPassword", async () => {
    const source = `
Future<void> login(String email, String pass) async {
  await FirebaseAuth.instance.signInWithEmailAndPassword(
    email: email, password: pass,
  );
}
`;
    const result = await parser.parseSource("login.dart", source);
    const p = result.infraPatterns.find((p) => p.kind === "firebase_auth");
    expect(p).toBeDefined();
    expect(p!.detail).toContain("signInWithEmailAndPassword");
  });

  it("detects signOut", async () => {
    const source = `
Future<void> logout() async {
  await FirebaseAuth.instance.signOut();
}
`;
    const result = await parser.parseSource("logout.dart", source);
    const p = result.infraPatterns.find((p) => p.kind === "firebase_auth");
    expect(p).toBeDefined();
  });
});

describe("Infrastructure Detection — Firebase Storage", () => {
  it("detects FirebaseStorage.instance", async () => {
    const source = `
void initStorage() {
  final storage = FirebaseStorage.instance;
}
`;
    const result = await parser.parseSource("storage.dart", source);
    const p = result.infraPatterns.find((p) => p.kind === "firebase_storage");
    expect(p).toBeDefined();
  });

  it("detects putFile upload", async () => {
    const source = `
Future<void> uploadAvatar(File file) async {
  await storageRef.putFile(file);
  final url = await storageRef.getDownloadURL();
}
`;
    const result = await parser.parseSource("upload.dart", source);
    const kinds = result.infraPatterns
      .filter((p) => p.kind === "firebase_storage")
      .map((p) => p.detail);
    expect(kinds.some((d) => d.includes("putFile"))).toBe(true);
    expect(kinds.some((d) => d.includes("getDownloadURL"))).toBe(true);
  });
});

describe("Infrastructure Detection — Firebase Messaging (FCM)", () => {
  it("detects FirebaseMessaging.instance", async () => {
    const source = `
void initFCM() {
  final messaging = FirebaseMessaging.instance;
}
`;
    const result = await parser.parseSource("fcm.dart", source);
    const p = result.infraPatterns.find((p) => p.kind === "firebase_messaging");
    expect(p).toBeDefined();
  });

  it("detects getToken call", async () => {
    const source = `
Future<String?> getFcmToken() async {
  return await messaging.getToken();
}
`;
    const result = await parser.parseSource("fcm.dart", source);
    const p = result.infraPatterns.find((p) => p.kind === "firebase_messaging");
    expect(p).toBeDefined();
  });

  it("detects subscribeToTopic", async () => {
    const source = `
void subscribeNews() {
  messaging.subscribeToTopic('news');
}
`;
    const result = await parser.parseSource("fcm.dart", source);
    const p = result.infraPatterns.find((p) => p.kind === "firebase_messaging");
    expect(p).toBeDefined();
  });
});

describe("Infrastructure Detection — Firebase Realtime DB", () => {
  it("detects FirebaseDatabase.instance", async () => {
    const source = `
void initRtdb() {
  final db = FirebaseDatabase.instance;
}
`;
    const result = await parser.parseSource("rtdb.dart", source);
    const p = result.infraPatterns.find(
      (p) => p.kind === "firebase_realtime_db",
    );
    expect(p).toBeDefined();
  });

  it("detects onValue stream", async () => {
    const source = `
void listenOrders() {
  ref.onValue.listen((event) => handleEvent(event));
}
`;
    const result = await parser.parseSource("rtdb.dart", source);
    const p = result.infraPatterns.find(
      (p) => p.kind === "firebase_realtime_db",
    );
    expect(p).toBeDefined();
  });
});

describe("Infrastructure Detection — Firebase Crashlytics", () => {
  it("detects FirebaseCrashlytics.instance", async () => {
    const source = `
void initCrashlytics() {
  FlutterError.onError = FirebaseCrashlytics.instance.recordFlutterFatalError;
}
`;
    const result = await parser.parseSource("crashlytics.dart", source);
    const p = result.infraPatterns.find(
      (p) => p.kind === "firebase_crashlytics",
    );
    expect(p).toBeDefined();
  });

  it("detects recordError call", async () => {
    const source = `
void handleError(Object e, StackTrace st) {
  FirebaseCrashlytics.instance.recordError(e, st);
}
`;
    const result = await parser.parseSource("crashlytics.dart", source);
    const p = result.infraPatterns.find(
      (p) => p.kind === "firebase_crashlytics",
    );
    expect(p).toBeDefined();
  });
});

describe("Infrastructure Detection — Firebase Analytics", () => {
  it("detects FirebaseAnalytics.instance", async () => {
    const source = `
void initAnalytics() {
  final analytics = FirebaseAnalytics.instance;
}
`;
    const result = await parser.parseSource("analytics.dart", source);
    const p = result.infraPatterns.find((p) => p.kind === "firebase_analytics");
    expect(p).toBeDefined();
  });

  it("detects logEvent with event name", async () => {
    const source = `
Future<void> trackPurchase(String item) async {
  await analytics.logEvent(name: 'purchase', parameters: {'item': item});
}
`;
    const result = await parser.parseSource("analytics.dart", source);
    const p = result.infraPatterns.find((p) => p.kind === "firebase_analytics");
    expect(p).toBeDefined();
  });

  it("detects setCurrentScreen", async () => {
    const source = `
void trackScreen(String name) {
  analytics.setCurrentScreen(screenName: name);
}
`;
    const result = await parser.parseSource("analytics.dart", source);
    const p = result.infraPatterns.find((p) => p.kind === "firebase_analytics");
    expect(p).toBeDefined();
  });
});
