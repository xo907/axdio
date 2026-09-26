"""End-to-end tests for the Axdio server, run against a throwaway config and music folder.

Run inside the app image (it has Flask, mutagen and ffmpeg):
    docker build -t axdio .
    docker run --rm -v "$PWD":/src -w /src --entrypoint python axdio -m unittest discover -s tests -v
"""
import gzip, hashlib, json, os, re, shutil, subprocess, sys, tempfile, threading, time, unittest, urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TMP = Path(tempfile.mkdtemp(prefix="axdio-test-"))
MUSIC, CONFIG = TMP / "music", TMP / "config"
SONGS = [("Test Artist", "First Album", "Opening", 1, 12.0), ("Test Artist", "First Album", "Second Song", 2, 9.5),
         ("Other Artist", "Other Album", "Something Else", 1, 7.25)]

def make_music():
    for artist, album, title, n, secs in SONGS:
        d = MUSIC / artist / album
        d.mkdir(parents=True, exist_ok=True)
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=44100:duration={secs}",
                        "-ac", "2", "-metadata", f"title={title}", "-metadata", f"artist={artist}", "-metadata", f"album={album}",
                        "-metadata", f"tracknumber={n}", str(d / f"{n:02d} - {title}.flac")], check=True)

make_music()
os.environ.update(CONFIG_DIR=str(CONFIG), CFG_DIR_MUSIC=str(MUSIC), SECRET_KEY="test-secret-key-for-unit-tests-only")
CONFIG.mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(ROOT))
import server  # noqa: E402  (imports after the environment is prepared)

server.scan_library()


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        server.app.config["TESTING"] = True

    def setUp(self):
        self.c = server.app.test_client()

    def settings(self, **values):
        server.cfg_save(values)

    def register(self, name, password="long-password-1", **extra):
        r = self.c.post("/api/auth/register", json={"username": name, "password": password, **extra})
        return r

    def token(self, name, password="long-password-1"):
        r = self.c.post("/api/auth/login", json={"username": name, "password": password})
        self.assertEqual(r.status_code, 200, r.get_json())
        return r.get_json()["token"]

    def admin(self):
        self.settings(admin_user="root", admin_password=server.hash_pw("admin-password-1"))
        c = server.app.test_client()
        r = c.post("/admin/login", data={"username": "root", "password": "admin-password-1"})
        self.assertEqual(r.status_code, 302)
        return c

    def rel(self, title):
        return next(k for k, v in server.library_cache_data.items() if v.get("title") == title)


class TestBasics(Base):
    def test_health_and_headers(self):
        r = self.c.get("/api/health")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json()["version"], server.AXDIO_VERSION)
        self.assertEqual(r.headers["X-Content-Type-Options"], "nosniff")
        self.assertIn("frame-ancestors", r.headers["Content-Security-Policy"])

    def test_scan_found_the_songs(self):
        titles = {v["title"] for v in server.library_cache_data.values()}
        self.assertEqual(titles, {s[2] for s in SONGS})
        e = server.library_cache_data[self.rel("Opening")]
        self.assertAlmostEqual(e["duration"], 12.0, places=1)

    def test_library_is_gzipped(self):
        r = self.c.get("/api/library/cache", headers={"Accept-Encoding": "gzip"})
        self.assertEqual(r.headers.get("Content-Encoding"), "gzip")
        data = json.loads(gzip.decompress(r.data))
        self.assertEqual(len(data["library"]), 2)

    def test_path_traversal_is_refused(self):
        for bad in ("../config/settings.json", "../../etc/passwd", "Test Artist/../../config/secret_key"):
            self.assertEqual(self.c.get("/api/stream_path", query_string={"path": bad}).status_code, 404, bad)


class TestAccounts(Base):
    def setUp(self):
        super().setUp()
        self.settings(registration="open", require_login=False, min_password_length=8, maintenance_mode=False)

    def test_register_login_sync(self):
        self.assertEqual(self.register("alice").status_code, 200)
        tok = self.token("alice")
        rel = self.rel("Opening")
        h = {"X-Auth-Token": tok}
        self.assertTrue(self.c.post("/api/user/sync", json={"liked_songs": [rel], "playlists": {"Mix": [rel]}}, headers=h).get_json()["success"])
        self.c.post("/api/user/record_play", json={"rel_path": rel}, headers=h)
        d = self.c.get("/api/user/sync", headers=h).get_json()
        self.assertEqual(d["liked_songs"], [rel])
        self.assertEqual(d["history"][0]["count"], 1)
        # Stored in SQLite with hashed tokens only.
        row = json.loads(server.db().execute("SELECT data FROM users WHERE username='alice'").fetchone()[0])
        self.assertTrue(all(len(t) == 64 for t in row["tokens"]))
        self.assertNotIn(tok, json.dumps(row))

    def test_token_in_url_is_ignored(self):
        self.register("bob")
        tok = self.token("bob")
        anon = server.app.test_client()   # no session cookie from the login above
        self.assertFalse(anon.get("/api/user/sync", query_string={"token": tok}).get_json()["authenticated"])

    def test_short_password_and_bad_username(self):
        self.assertEqual(self.register("carol", "short").status_code, 400)
        self.assertEqual(self.register("Bad Name!", "long-password-1").status_code, 400)

    def test_closed_and_invite_only(self):
        self.settings(registration="closed")
        self.assertEqual(self.register("dave").status_code, 403)
        admin = self.admin()
        self.settings(registration="invite")
        self.assertEqual(self.register("dave").status_code, 403)
        code = admin.post("/api/admin/v2/invites", json={"max_uses": 1}).get_json()["invites"][0]["code"]
        self.assertEqual(self.register("dave", invite_code=code).status_code, 200)
        self.assertEqual(self.register("erin", invite_code=code).status_code, 403)   # single use

    def test_private_server(self):
        self.register("frank")
        tok = self.token("frank")
        self.settings(require_login=True)
        anon = server.app.test_client()
        try:
            self.assertEqual(anon.get("/api/library/version").status_code, 401)
            self.assertEqual(anon.get("/api/library/version", headers={"X-Auth-Token": tok}).status_code, 200)
            self.assertEqual(server.app.test_client().get("/api/health").status_code, 200)
        finally:
            self.settings(require_login=False)

    def test_disable_and_sign_out_everywhere(self):
        self.register("gina")
        tok = self.token("gina")
        admin = self.admin()
        admin.post("/api/admin/v2/users/gina/signout")
        self.assertEqual(self.c.get("/api/user/sessions", headers={"X-Auth-Token": tok}).status_code, 401)
        admin.post("/api/admin/v2/users/gina/update", json={"disabled": True})
        self.assertEqual(self.c.post("/api/auth/login", json={"username": "gina", "password": "long-password-1"}).status_code, 403)

    def test_self_service(self):
        self.register("hank")
        tok = self.token("hank")
        h = {"X-Auth-Token": tok}
        self.token("hank")   # a second device
        self.assertEqual(len(self.c.get("/api/user/sessions", headers=h).get_json()["sessions"]), 3)
        self.assertEqual(self.c.post("/api/user/sessions/revoke", json={"others": True}, headers=h).get_json()["removed"], 2)
        export = json.loads(self.c.get("/api/user/export", headers=h).data)
        self.assertNotIn("password", export["account"])
        self.assertEqual(self.c.post("/api/user/delete_account", json={"password": "wrong"}, headers=h).status_code, 400)
        self.assertEqual(self.c.post("/api/user/delete_account", json={"password": "long-password-1"}, headers=h).status_code, 200)
        self.assertNotIn("hank", server.users_data)

    def test_login_lockout(self):
        self.settings(login_max_attempts=3)
        env = {"REMOTE_ADDR": "10.9.9.9"}
        for _ in range(3):
            self.assertEqual(self.c.post("/api/auth/login", json={"username": "x", "password": "y"}, environ_base=env).status_code, 401)
        self.assertEqual(self.c.post("/api/auth/login", json={"username": "x", "password": "y"}, environ_base=env).status_code, 429)
        self.settings(login_max_attempts=10)


class TestAdmin(Base):
    def test_admin_api_needs_login(self):
        self.assertEqual(self.c.get("/api/admin/v2/config").status_code, 401)

    def test_settings_validation_and_saving(self):
        admin = self.admin()
        self.assertEqual(admin.post("/api/admin/v2/config", json={"values": {"accent_color": "red"}}).status_code, 400)
        r = admin.post("/api/admin/v2/config", json={"values": {"site_title": "Test Server"}})
        self.assertIn("site_title", r.get_json()["changed"])
        raw = json.loads((CONFIG / "settings.json").read_text())
        self.assertNotIn("scan_interval", raw)   # defaults aren't frozen into the file
        self.assertEqual(self.c.get("/api/branding").get_json()["settings"]["site_title"], "Test Server")

    def test_maintenance_mode(self):
        admin = self.admin()
        self.settings(maintenance_mode=True)
        try:
            self.assertEqual(self.c.get("/api/library/version").status_code, 503)
            self.assertEqual(admin.get("/api/library/version").status_code, 200)
        finally:
            self.settings(maintenance_mode=False)

    def test_backups(self):
        admin = self.admin()
        names = [b["name"] for b in admin.post("/api/admin/v2/backups").get_json()["backups"]]
        self.assertTrue(names)
        with gzip.open(CONFIG / "backups" / names[0], "rt") as f:
            self.assertEqual(json.load(f)["format"], "axdio-backup")
        self.assertEqual(admin.get("/api/admin/v2/backups/..%2Fsettings.json").status_code, 404)


class TestSecurityExtras(Base):
    def test_admin_two_factor(self):
        admin = self.admin()
        secret = admin.post("/api/admin/v2/2fa", json={"action": "start"}).get_json()["secret"]
        now = int(time.time() // 30)
        self.assertEqual(admin.post("/api/admin/v2/2fa", json={"action": "confirm", "code": "000000"}).status_code, 400)
        self.assertTrue(admin.post("/api/admin/v2/2fa", json={"action": "confirm", "code": server.totp_code(secret, now)}).get_json()["enabled"])
        c = server.app.test_client()
        r = c.post("/admin/login", data={"username": "root", "password": "admin-password-1"})
        self.assertEqual(r.status_code, 200)
        self.assertIn(b'name="code"', r.data)                       # asks for the code, not signed in yet
        self.assertEqual(c.get("/api/admin/v2/me").status_code, 401)
        self.assertEqual(c.post("/admin/login", data={"code": server.totp_code(secret, now)}).status_code, 200)   # already used
        self.assertEqual(c.post("/admin/login", data={"code": server.totp_code(secret, now + 1)}).status_code, 302)
        self.assertEqual(c.get("/api/admin/v2/me").status_code, 200)
        c.post("/api/admin/v2/2fa", json={"action": "disable", "code": server.totp_code(secret, now - 1)})   # older than last use
        self.assertTrue(c.get("/api/admin/v2/2fa").get_json()["enabled"])
        server.set_admin_totp("root", "builtin", None)

    def test_metrics(self):
        self.assertEqual(self.c.get("/metrics").status_code, 404)   # off without a token
        self.settings(metrics_token="abc123")
        self.assertEqual(self.c.get("/metrics", headers={"Authorization": "Bearer nope"}).status_code, 404)
        r = self.c.get("/metrics", headers={"Authorization": "Bearer abc123"})
        self.assertIn(b"axdio_library_tracks 3", r.data)
        self.settings(metrics_token="")


class TestStreaming(Base):
    def test_original_with_range(self):
        r = self.c.get("/api/stream_path", query_string={"path": self.rel("Opening")}, headers={"Range": "bytes=0-99"})
        self.assertEqual(r.status_code, 206)
        self.assertEqual(len(r.data), 100)

    def test_data_saver_size_is_exact(self):
        rel = self.rel("Second Song")
        r = self.c.get("/api/stream_path", query_string={"path": rel, "q": "low"})
        self.assertEqual(r.mimetype, "audio/mpeg")
        body = r.data
        self.assertEqual(len(body), int(r.headers["Content-Length"]))
        samples = round(9.5 * 48000)
        self.assertEqual(len(body), (samples // 1152 + 2) * 3 * 128)
        time.sleep(0.5)
        cached = self.c.get("/api/stream_path", query_string={"path": rel, "q": "low"}, headers={"Range": "bytes=0-"})
        self.assertEqual(cached.data, body)
        cached.close()


class TestSubsonic(Base):
    def setUp(self):
        super().setUp()
        if "sub" not in server.users_data: self.register("sub")
        self.tok = self.token("sub")
        self.pw = self.c.post("/api/user/subsonic", json={"action": "create"}, headers={"X-Auth-Token": self.tok}).get_json()["password"]

    def call(self, method, **params):
        salt = "s4lt"
        q = {"u": "sub", "t": hashlib.md5((self.pw + salt).encode()).hexdigest(), "s": salt, "v": "1.16.1", "c": "test", "f": "json", **params}
        return self.c.get(f"/rest/{method}", query_string=q)

    def test_ping_and_errors(self):
        self.assertEqual(self.call("ping.view").get_json()["subsonic-response"]["status"], "ok")
        bad = self.c.get("/rest/ping", query_string={"u": "sub", "p": "nope", "f": "json"}).get_json()["subsonic-response"]
        self.assertEqual(bad["error"]["code"], 40)

    def test_browse_search_star_stream(self):
        r = self.call("search3", query="", songCount=50).get_json()["subsonic-response"]["searchResult3"]
        self.assertEqual(len(r["song"]), 3)
        song = next(s for s in r["song"] if s["title"] == "Opening")
        self.call("star", id=song["id"])
        liked = self.c.get("/api/user/sync", headers={"X-Auth-Token": self.tok}).get_json()["liked_songs"]
        self.assertIn(song["path"], liked)
        album = self.call("getAlbum", id=song["albumId"]).get_json()["subsonic-response"]["album"]
        self.assertEqual(album["songCount"], 2)
        s = self.call("stream", id=song["id"])
        self.assertEqual(s.status_code, 200)
        self.assertTrue(s.data.startswith(b"fLaC"))
        s.close()

    def test_xml(self):
        import xml.etree.ElementTree as ET
        q = {"u": "sub", "p": self.pw, "v": "1.16.1", "c": "test"}
        root = ET.fromstring(self.c.get("/rest/getArtists", query_string=q).data)
        self.assertEqual(root.get("status"), "ok")


def image_bytes(codec="png", size="640x480"):
    return subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", f"testsrc=size={size}", "-frames:v", "1",
                           "-f", "image2pipe", "-vcodec", codec, "-"], capture_output=True, check=True).stdout

def jpeg_size(data):
    """(width, height) from a JPEG's SOF marker."""
    i = 2
    while i < len(data):
        marker, length = data[i + 1], int.from_bytes(data[i + 2:i + 4], "big")
        if marker in (0xC0, 0xC1, 0xC2):
            return int.from_bytes(data[i + 7:i + 9], "big"), int.from_bytes(data[i + 5:i + 7], "big")
        i += 2 + length
    return None


class TestSharing(Base):
    def test_ids_match_the_web_apps(self):
        # The same inputs give these ids in web/app/core.js shareId().
        self.assertEqual(server.share_id("r", "deadmau5"), "20CvRJNXP7x")
        self.assertEqual(server.share_id("a", "*\x01ビートルズ — ça ☕"), "7XFXdOTPv5e")

    def test_pages(self):
        rel = self.rel("Opening")
        sid = server.share_id("t", rel)
        html = self.c.get(f"/track/{sid}").get_data(as_text=True)
        self.assertIn('<meta property="og:title" content="Opening">', html)
        self.assertIn("Test Artist", html)
        self.assertIn("/api/stream_path?path=", html)
        album = self.c.get("/album/" + server.share_id("a", "test artist\x01first album"))
        self.assertEqual(album.status_code, 200)
        self.assertIn("Second Song", album.get_data(as_text=True))
        self.assertEqual(self.c.get("/artist/" + server.share_id("r", "other artist")).status_code, 200)
        self.assertEqual(self.c.get("/track/AAAAAAAAAAA").status_code, 404)
        r = self.c.get(f"/track/{sid}/open")
        self.assertEqual(r.status_code, 302)
        self.assertIn("play=", r.headers["Location"])

    def test_preview_image(self):
        rel = self.rel("Second Song")
        cover = server.COVERS_CACHE_DIR / (hashlib.md5(rel.encode()).hexdigest() + ".jpg")
        cover.write_bytes(image_bytes("mjpeg", "300x300"))
        server.library_cache_data[rel]["has_cover"] = True   # as the scanner marks songs with embedded art
        server.rebuild_in_memory_tree()
        try:
            sid = server.share_id("t", rel)
            html = self.c.get(f"/track/{sid}").get_data(as_text=True)
            self.assertIn('property="og:image"', html)
            self.assertIn('name="theme-color" content="#', html)
            r = self.c.get(f"/track/{sid}/card.jpg")
            self.assertEqual(r.status_code, 200)
            self.assertEqual(jpeg_size(r.data), (1200, 630))
            r.close()
        finally:
            cover.unlink(missing_ok=True)
            server.library_cache_data[rel]["has_cover"] = False
            server.rebuild_in_memory_tree()

    def test_private_server(self):
        rel = self.rel("Opening")
        sid = server.share_id("t", rel)
        self.settings(require_login=True)
        anon = server.app.test_client()
        try:
            html = anon.get(f"/track/{sid}").get_data(as_text=True)
            self.assertIn("og:title", html)
            self.assertNotIn("stream_path", html)
            self.assertNotIn(Path(rel).name, html)
            self.assertIn("/?next=", anon.get(f"/track/{sid}/open").headers["Location"])
            self.settings(share_previews=False)
            self.assertEqual(anon.get(f"/track/{sid}").status_code, 302)
            self.assertEqual(anon.get(f"/track/{sid}/cover.jpg").status_code, 404)
        finally:
            self.settings(require_login=False, share_previews=True)

    def test_sharing_off(self):
        sid = server.share_id("t", self.rel("Opening"))
        self.settings(feature_sharing=False)
        try: self.assertEqual(self.c.get(f"/track/{sid}").status_code, 404)
        finally: self.settings(feature_sharing=True)


class TestAvatars(Base):
    def test_upload_replace_and_remove(self):
        self.register("ivy")
        h = {"X-Auth-Token": self.token("ivy")}
        r = self.c.post("/api/user/avatar", data=image_bytes(), headers={**h, "Content-Type": "image/png"})
        self.assertEqual(r.status_code, 200, r.get_json())
        url = r.get_json()["avatar"]
        self.assertRegex(url, r"^/api/avatar/[0-9a-f]{20}\.jpg$")
        img = self.c.get(url)
        self.assertEqual(jpeg_size(img.data), (512, 512))
        img.close()
        self.assertEqual(self.c.get("/api/user/sync", headers=h).get_json()["avatar"], url)
        self.assertEqual(self.c.post("/api/user/avatar", data=b"<svg></svg>", headers=h).status_code, 400)
        url2 = self.c.post("/api/user/avatar", data=image_bytes("mjpeg"), headers=h).get_json()["avatar"]
        self.assertEqual(self.c.get(url).status_code, 404)   # the old photo is deleted
        self.assertEqual(self.c.post("/api/user/profile", json={"avatar": "javascript:alert(1)"}, headers=h).status_code, 400)
        self.admin().post("/api/admin/v2/users/ivy/remove_avatar")
        self.assertEqual(self.c.get(url2).status_code, 404)
        self.assertEqual(server.users_data["ivy"]["avatar"], "")

    def test_turned_off(self):
        self.register("jay")
        h = {"X-Auth-Token": self.token("jay")}
        self.settings(feature_avatars=False)
        try: self.assertEqual(self.c.post("/api/user/avatar", data=image_bytes(), headers=h).status_code, 403)
        finally: self.settings(feature_avatars=True)


def b64(n, fill="A"):
    return fill * n

def fake_keys(tag="A"):
    return {"enc": b64(87, tag), "sig": b64(87, tag), "fp": (tag.lower() * 64)[:64] if tag.lower() in "abcdef" else "a" * 64,
            "backup": {"salt": b64(22), "iv": b64(16), "ct": b64(40)}}

def sealed(): return {"iv": b64(16), "ct": b64(40)}


class Social(Base):
    def user(self, name):
        if name not in server.users_data: self.register(name)
        return {"X-Auth-Token": self.token(name)}

    def friends(self, a, b):
        ha, hb = self.user(a), self.user(b)
        self.c.post("/api/social/friends/request", json={"username": b}, headers=ha)
        self.c.post("/api/social/friends/accept", json={"username": a}, headers=hb)
        return ha, hb


class TestFriends(Social):
    def test_requests_search_and_blocking(self):
        ha, hb = self.user("sam"), self.user("tia")
        self.assertEqual(self.c.get("/api/social/search?q=ti", headers=ha).get_json()["users"][0]["username"], "tia")
        pulse = self.c.get("/api/social/pulse", headers=hb).get_json()
        self.assertEqual(self.c.post("/api/social/friends/request", json={"username": "tia"}, headers=ha).get_json()["state"], "outgoing")
        after = self.c.get("/api/social/pulse", headers=hb).get_json()
        self.assertEqual(after["requests"], 1)
        self.assertGreater(after["f"], pulse["f"])
        self.assertEqual(self.c.post("/api/social/friends/accept", json={"username": "sam"}, headers=hb).get_json()["state"], "friend")
        self.assertEqual([f["username"] for f in self.c.get("/api/social/me", headers=ha).get_json()["friends"]], ["tia"])
        self.c.post("/api/social/friends/block", json={"username": "sam"}, headers=hb)
        self.assertEqual(self.c.get("/api/social/me", headers=ha).get_json()["friends"], [])
        self.assertEqual(self.c.post("/api/social/friends/request", json={"username": "tia"}, headers=ha).status_code, 403)
        self.assertEqual(self.c.get("/api/social/search?q=tia", headers=ha).get_json()["users"], [])
        self.c.post("/api/social/settings", json={"discoverable": False}, headers=ha)
        self.user("uma")
        self.assertEqual(self.c.get("/api/social/search?q=sa", headers=self.user("uma")).get_json()["users"], [])
        self.assertEqual(len(self.c.get("/api/social/search?q=sam", headers=self.user("uma")).get_json()["users"]), 1)   # exact username still works

    def test_activity_and_profiles(self):
        ha, hb = self.friends("vic", "wes")
        rel = self.rel("Opening")
        c = server.app.test_client()
        c.post("/api/auth/login", json={"username": "wes", "password": "long-password-1"})
        c.post("/api/player/now_playing", json={"src": "/api/stream_path?path=" + rel, "status": "STREAMING"})
        now = self.c.get("/api/social/activity", headers=ha).get_json()["friends"][0]["now"]
        self.assertEqual(now["rel"], rel)
        self.assertTrue(now["live"])
        prof = self.c.get("/api/social/users/wes", headers=ha).get_json()
        self.assertEqual(prof["state"], "friend")
        self.assertEqual(prof["now"]["rel"], rel)
        self.c.post("/api/social/settings", json={"share_activity": False}, headers=hb)
        self.assertIsNone(self.c.get("/api/social/activity", headers=ha).get_json()["friends"][0]["now"])
        stranger = self.c.get("/api/social/users/wes", headers=self.user("xan")).get_json()
        self.assertEqual(stranger["state"], "none")
        self.assertNotIn("recent", stranger)


class TestCollabPlaylists(Social):
    def test_editing_together(self):
        ha, hb = self.friends("yan", "zed")
        hc = self.user("amy")
        one, two, three = self.rel("Opening"), self.rel("Second Song"), self.rel("Something Else")
        pl = self.c.post("/api/social/playlists", json={"name": "Road trip", "tracks": [one], "collaborators": ["zed", "amy"]}, headers=ha).get_json()
        self.assertEqual(pl["collaborators"], ["zed"])   # amy isn't yan's friend
        op = lambda h, **d: self.c.post(f"/api/social/playlists/{pl['id']}", json=d, headers=h)
        self.assertEqual([t["r"] for t in op(hb, op="add", rels=[two, three, one]).get_json()["tracks"]], [one, two, three])
        self.assertEqual([t["by"] for t in op(hb, op="move", rel=three, before=one).get_json()["tracks"]], ["zed", "yan", "zed"])
        self.assertEqual(op(hb, op="rename", name="Mine now").status_code, 403)
        self.assertEqual(op(hc, op="add", rels=[two]).status_code, 404)
        self.assertEqual(len(op(ha, op="remove", rels=[one]).get_json()["tracks"]), 2)
        self.assertEqual(len(self.c.get("/api/social/playlists", headers=hb).get_json()["playlists"]), 1)
        op(hb, op="leave")
        self.assertEqual(self.c.get("/api/social/playlists", headers=hb).get_json()["playlists"], [])
        self.assertTrue(op(ha, op="delete").get_json()["deleted"])


class TestMessages(Social):
    def test_keys_dm_and_messages(self):
        ha, hb = self.friends("bea", "cal")
        self.assertEqual(self.c.post("/api/chat/keys", json={"enc": "x"}, headers=ha).status_code, 400)
        self.assertEqual(self.c.post("/api/chat/keys", json=fake_keys("A"), headers=ha).status_code, 200)
        self.assertEqual(self.c.post("/api/chat/keys", json=fake_keys("B"), headers=ha).status_code, 409)   # needs reset=true
        self.c.post("/api/chat/keys", json=fake_keys("C"), headers=hb)
        keys = self.c.get("/api/chat/keys?users=bea,cal,nobody", headers=ha).get_json()["keys"]
        self.assertEqual(keys["bea"]["enc"], "A" * 87)
        self.assertIsNone(keys["nobody"])
        conv = self.c.post("/api/chat/dm", json={"username": "cal"}, headers=ha).get_json()
        self.assertEqual(self.c.post("/api/chat/dm", json={"username": "bea"}, headers=hb).get_json()["id"], conv["id"])
        cid = conv["id"]
        msg = dict(sealed(), id="m" * 20, v=1, sig=b64(86))
        self.assertEqual(self.c.post(f"/api/chat/{cid}/messages", json=msg, headers=ha).status_code, 409)   # no key yet
        key = {"v": 1, "conv": cid, "by": "bea", "ts": 1, "ev": 0, "members": ["bea", "cal"], "sig": b64(86),
               "wraps": {m: dict(sealed(), e=b64(87)) for m in ("bea", "cal")}, "fps": {m: "a" * 64 for m in ("bea", "cal")}}
        self.assertEqual(self.c.post(f"/api/chat/{cid}/keys", json={"key": dict(key, members=["bea"])}, headers=ha).status_code, 409)
        self.assertEqual(self.c.post(f"/api/chat/{cid}/keys", json={"key": key}, headers=ha).status_code, 200)
        sent = self.c.post(f"/api/chat/{cid}/messages", json=msg, headers=ha).get_json()["message"]
        self.assertEqual(sent["sender"], "bea")
        self.assertEqual(self.c.get("/api/social/pulse", headers=hb).get_json()["unread"], 1)
        got = self.c.get(f"/api/chat/{cid}/messages", headers=hb).get_json()["messages"]
        self.assertEqual(got[0]["ct"], msg["ct"])
        self.c.post(f"/api/chat/{cid}/read", json={"seq": sent["seq"]}, headers=hb)
        self.assertEqual(self.c.get("/api/social/pulse", headers=hb).get_json()["unread"], 0)
        self.assertEqual(self.c.delete(f"/api/chat/{cid}/messages/{msg['id']}", headers=hb).status_code, 403)
        self.assertEqual(self.c.delete(f"/api/chat/{cid}/messages/{msg['id']}", headers=ha).status_code, 200)
        self.assertTrue(self.c.get(f"/api/chat/{cid}/messages", headers=hb).get_json()["messages"][0]["deleted"])
        self.assertEqual(self.c.get(f"/api/chat/{cid}/messages", headers=self.user("dee")).status_code, 404)
        self.assertEqual(self.c.post("/api/chat/dm", json={"username": "dee"}, headers=ha).status_code, 403)   # not friends
        self.c.post("/api/social/friends/block", json={"username": "bea"}, headers=hb)
        self.assertEqual(self.c.post(f"/api/chat/{cid}/messages", json=dict(msg, id="n" * 20), headers=ha).status_code, 403)

    def test_groups_and_account_removal(self):
        ha, hb = self.friends("eve", "fay")
        _, hc = self.friends("eve", "gus")
        self.friends("eve", "hal")
        ev = {"t": "create", "by": "eve", "n": 0, "prev": "", "ts": 1, "sig": b64(86), "conv": "gr_" + "G" * 22, "members": ["eve", "fay", "gus"]}
        self.assertEqual(self.c.post("/api/chat/groups", json={"event": dict(ev, members=["eve", "fay", "zzz"])}, headers=ha).status_code, 403)
        conv = self.c.post("/api/chat/groups", json={"event": ev}, headers=ha).get_json()
        cid = conv["id"]
        event = lambda h, **e: self.c.post(f"/api/chat/{cid}/events", json={"event": dict({"prev": b64(43), "ts": 2, "sig": b64(86), "conv": cid}, **e)}, headers=h)
        self.assertEqual(event(hb, t="remove", by="fay", n=1, user="gus").status_code, 403)   # only the admin
        self.assertEqual(event(ha, t="add", by="eve", n=1, user="hal").get_json()["members"], ["eve", "fay", "gus", "hal"])
        self.assertEqual(event(ha, t="add", by="eve", n=1, user="hal").status_code, 409)       # stale event number
        self.assertTrue(event(hc, t="leave", by="gus", n=2).get_json()["left"])
        admin = self.admin()
        admin.post("/api/admin/v2/users/eve/delete")
        c = self.c.get(f"/api/chat/{cid}", headers=hb).get_json()
        self.assertEqual(c["members"], ["fay", "hal"])
        self.assertEqual(c["events"][-1]["t"], "gone")
        self.assertEqual(self.c.get("/api/social/me", headers=hb).get_json()["friends"], [])

    def test_linking_a_device(self):
        h = self.user("ida")
        self.c.post("/api/chat/keys", json=fake_keys("A"), headers=h)
        lid = self.c.post("/api/chat/link", json={"pub": b64(87)}, headers=h).get_json()["id"]
        self.assertEqual(self.c.get("/api/social/pulse", headers=h).get_json()["links"], 1)
        self.assertEqual(self.c.get("/api/chat/links", headers=h).get_json()["links"][0]["id"], lid)
        self.assertEqual(self.c.post(f"/api/chat/link/{lid}/approve", json={"x": b64(87), "blob": sealed()}, headers=self.user("jo")).status_code, 404)
        self.c.post(f"/api/chat/link/{lid}/approve", json={"x": b64(87), "blob": sealed()}, headers=h)
        self.assertEqual(self.c.get(f"/api/chat/link/{lid}", headers=h).get_json()["state"], "approved")

    def test_turned_off(self):
        h = self.user("kim")
        self.settings(feature_chat=False)
        try:
            self.assertEqual(self.c.get("/api/chat/conversations", headers=h).status_code, 403)
            self.assertEqual(self.c.get("/api/social/me", headers=h).status_code, 200)
        finally: self.settings(feature_chat=True)


class TestLibrarySharing(Social):
    """The test server shares its library with itself over real HTTP."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from werkzeug.serving import make_server
        import threading
        cls.httpd = make_server("127.0.0.1", 0, server.app, threaded=True)
        cls.port = cls.httpd.server_port
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def test_share_connect_play_and_stop(self):
        admin = self.admin()
        url = f"http://127.0.0.1:{self.port}"
        self.settings(public_url=url)
        try:
            made = admin.post("/api/admin/v2/federation/shares", json={"label": "Friend's server"}).get_json()
            self.assertTrue(made["key"].startswith("axs_"))
            self.assertEqual(admin.post("/api/admin/v2/federation/remotes", json={"url": url, "key": "axs_" + "x" * 40}).status_code, 400)
            r = admin.post("/api/admin/v2/federation/remotes", json={"code": made["code"]}).get_json()
            rid = r["view"]["remotes"][0]["id"]
            server.fed_sync(rid, force=True)
            shared = [t["rel_path"] for a in server.cached_prebuilt_tree for al in a["albums"] for t in al["tracks"] if t["rel_path"].startswith("@")]
            self.assertEqual(len(shared), len(server.library_cache_data))
            rel = next(x for x in shared if x.endswith("01 - Opening.flac"))
            song = self.c.get("/api/stream_path", query_string={"path": rel}, headers={"Range": "bytes=0-99"})
            self.assertEqual(song.status_code, 206)
            self.assertEqual(song.data[:4], b"fLaC")
            self.assertEqual(len(song.data), 100)
            song.close()
            self.assertIn(rel, [e[0] for e in server.fed_library_entries()])
            self.assertEqual(server._track_meta(rel)["title"], "Opening")
            # Shared songs never get public share pages.
            self.assertNotIn(rel, {v["t"]["rel_path"] for v in server.share_index()["track"].values()})
            view = admin.get("/api/admin/v2/federation").get_json()
            self.assertEqual(view["shares"][0]["peer_url"], url)
            admin.delete(f"/api/admin/v2/federation/shares/{view['shares'][0]['id']}")
            server.fed_sync(rid)
            self.assertEqual(admin.get("/api/admin/v2/federation").get_json()["remotes"][0]["status"], "revoked")
            self.assertFalse([1 for a in server.cached_prebuilt_tree for al in a["albums"] for t in al["tracks"] if t["rel_path"].startswith("@")])
            admin.delete(f"/api/admin/v2/federation/remotes/{rid}")
        finally:
            self.settings(public_url="")

    def test_share_back_offer(self):
        admin = self.admin()
        url = f"http://127.0.0.1:{self.port}"
        self.settings(public_url=url)
        try:
            made = admin.post("/api/admin/v2/federation/shares", json={"label": "Both ways"}).get_json()
            r = admin.post("/api/admin/v2/federation/remotes", json={"url": url, "key": made["key"], "share_back": True}).get_json()
            self.assertIn("offer", r["message"])
            view = admin.get("/api/admin/v2/federation").get_json()
            # The other side (here, the same server) already has the connection, so the offer is recorded as known.
            self.assertEqual(len(view["remotes"]), 1)
            for x in view["remotes"]: admin.delete(f"/api/admin/v2/federation/remotes/{x['id']}")
            for x in admin.get("/api/admin/v2/federation").get_json()["shares"]: admin.delete(f"/api/admin/v2/federation/shares/{x['id']}")
        finally:
            self.settings(public_url="")

    def test_federation_needs_a_key(self):
        self.assertEqual(self.c.get("/api/federation/library").status_code, 401)
        self.assertEqual(self.c.get("/api/federation/library", headers={"Authorization": "Bearer axs_nope"}).status_code, 401)


class TestDiscord(Social):
    def fake_discord(self, uid="123456789012345678", username="Night.Owl", name="Night Owl"):
        def fake(url, data=None, headers=None, timeout=10):
            if url.endswith("/oauth2/token"): return {"access_token": "at", "token_type": "Bearer"}
            if url.endswith("/users/@me"): return {"id": uid, "username": username, "global_name": name, "avatar": None}
            return {}
        server._http_json, self._orig = fake, server._http_json

    def tearDown(self):
        if hasattr(self, "_orig"): server._http_json = self._orig

    def sign_in(self, c, link=False):
        r = c.get("/auth/discord" + ("?link=1" if link else ""))
        self.assertEqual(r.status_code, 302, r.data[:200])
        self.assertIn("discord.com/oauth2/authorize", r.headers["Location"])
        state = urllib.parse.parse_qs(urllib.parse.urlparse(r.headers["Location"]).query)["state"][0]
        return c.get("/auth/discord/callback", query_string={"code": "abc", "state": state})

    def test_sign_up_link_and_unlink(self):
        c = server.app.test_client()
        self.assertIn("discord=unavailable", c.get("/auth/discord").headers["Location"])
        self.settings(discord_login=True, discord_client_id="123456789012345678", discord_client_secret="s3cret", registration="open")
        try:
            self.fake_discord()
            loc = self.sign_in(c).headers["Location"]
            code = urllib.parse.parse_qs(urllib.parse.urlparse(loc).query)["login"][0]
            d = c.post("/api/auth/exchange", json={"code": code}).get_json()
            self.assertEqual(d["username"], "night.owl")
            self.assertEqual(d["display_name"], "Night Owl")
            self.assertEqual(c.post("/api/auth/exchange", json={"code": code}).status_code, 400)   # single use
            h = {"X-Auth-Token": d["token"]}
            sync = c.get("/api/user/sync", headers=h).get_json()
            self.assertFalse(sync["password_login"])
            self.assertEqual(sync["discord"]["username"], "Night.Owl")
            self.assertEqual(c.post("/api/user/discord/unlink", headers=h).status_code, 400)
            self.assertEqual(c.post("/api/user/change_password", json={"new_password": "long-password-9"}, headers=h).status_code, 200)
            self.assertEqual(c.post("/api/user/discord/unlink", headers=h).status_code, 200)
            # Linking it to another account, then signing in with Discord lands in that account.
            self.register("pia")
            c2 = server.app.test_client()
            c2.post("/api/auth/login", json={"username": "pia", "password": "long-password-1"})
            self.assertIn("discord=linked", self.sign_in(c2, link=True).headers["Location"])
            loc = self.sign_in(server.app.test_client()).headers["Location"]
            code = urllib.parse.parse_qs(urllib.parse.urlparse(loc).query)["login"][0]
            self.assertEqual(server.app.test_client().post("/api/auth/exchange", json={"code": code}).get_json()["username"], "pia")
        finally:
            self.settings(discord_login=False, discord_client_id="", discord_client_secret="", registration="open")

    def test_redirect_follows_the_page_address(self):
        """Behind a proxy that doesn't pass on the host, the sign-in page's address is what Discord must send people back to."""
        self.settings(discord_login=True, discord_client_id="123456789012345678", discord_client_secret="s3cret", registration="open")
        try:
            sent = []
            def fake(url, data=None, headers=None, timeout=10):
                if url.endswith("/oauth2/token"):
                    sent.append(urllib.parse.parse_qs(data.decode() if isinstance(data, bytes) else urllib.parse.urlencode(data))["redirect_uri"][0])
                    return {"access_token": "at"}
                if url.endswith("/users/@me"): return {"id": "423456789012345678", "username": "proxied"}
                return {}
            server._http_json, self._orig = fake, server._http_json
            c = server.app.test_client()
            r = c.get("/auth/discord", query_string={"o": "https://music.example.com"})
            q = urllib.parse.parse_qs(urllib.parse.urlparse(r.headers["Location"]).query)
            self.assertEqual(q["redirect_uri"], ["https://music.example.com/auth/discord/callback"])
            c.get("/auth/discord/callback", query_string={"code": "abc", "state": q["state"][0]})
            self.assertEqual(sent, ["https://music.example.com/auth/discord/callback"])   # the same one, for the token
            for bad in ("javascript:alert(1)", "https://evil.example.com/x?y", ""):
                r = c.get("/auth/discord", query_string={"o": bad})
                q = urllib.parse.parse_qs(urllib.parse.urlparse(r.headers["Location"]).query)
                self.assertEqual(q["redirect_uri"], ["http://localhost/auth/discord/callback"])
            d = self.admin().get("/api/admin/v2/discord").get_json()
            self.assertEqual((d["server_sees"], d["redirect_path"]), ("http://localhost", "/auth/discord/callback"))
        finally:
            self.settings(discord_login=False, discord_client_id="", discord_client_secret="", registration="open")

    def test_invite_only_and_closed(self):
        self.settings(discord_login=True, discord_client_id="123456789012345678", discord_client_secret="s3cret", registration="invite")
        try:
            self.fake_discord(uid="223456789012345678", username="guest")
            c = server.app.test_client()
            self.assertIn("discord=invite", self.sign_in(c).headers["Location"])
            self.assertEqual(c.post("/api/auth/discord/finish", json={"invite_code": "NOPE"}).status_code, 403)
            code = self.admin().post("/api/admin/v2/invites", json={"max_uses": 1}).get_json()["invites"][0]["code"]
            self.assertEqual(c.post("/api/auth/discord/finish", json={"invite_code": code}).get_json()["username"], "guest")
            self.settings(registration="closed")
            self.fake_discord(uid="323456789012345678", username="stranger")
            self.assertIn("discord=no-account", self.sign_in(server.app.test_client()).headers["Location"])
        finally:
            self.settings(discord_login=False, discord_client_id="", discord_client_secret="", registration="open")


class TestDiscordStatus(Social):
    def test_helper_uses_the_page_address(self):
        self.settings(discord_client_id="123456789012345678", discord_presence=True)
        try:
            h = self.user("ada")
            made = self.c.post("/api/user/presence", headers=dict(h, Origin="https://music.example.com")).get_json()
            self.assertIn("SERVER = 'https://music.example.com'", made["script"])
            self.settings(public_url="https://tunes.example.org/")
            made = self.c.post("/api/user/presence", headers=dict(h, Origin="https://music.example.com")).get_json()
            self.assertIn("SERVER = 'https://tunes.example.org'", made["script"])
        finally:
            self.settings(discord_client_id="", public_url="")

    def test_helper_sets_itself_up(self):
        """Opened once, the helper installs itself, runs in the background, starts at sign-in, and can be removed."""
        import socket
        from werkzeug.serving import make_server
        self.settings(discord_client_id="123456789012345678", discord_presence=True)
        srv = make_server("127.0.0.1", 0, server.app, threaded=True)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        home = TMP / "helper-home"
        env = dict(os.environ, HOME=str(home), XDG_DATA_HOME=str(home / "data"), XDG_CONFIG_HOME=str(home / "config"), PATH="/usr/local/bin:/usr/bin:/bin")
        data, autostart = home / "data" / "Axdio", home / "config" / "autostart" / "axdio-discord.desktop"
        def running():
            try: socket.create_connection(("127.0.0.1", 47823), timeout=1).close(); return True
            except OSError: return False
        def wait(cond, secs=20):
            for _ in range(secs * 10):
                if cond(): return True
                time.sleep(0.1)
            return False
        def helper(h):
            made = self.c.post("/api/user/presence", headers=h).get_json()
            key = re.search(r"KEY = '(axp_[^']+)'", made["script"]).group(1)
            f = home / "Downloads" / "axdio-discord.py"
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(server.presence_helper(f"http://127.0.0.1:{srv.server_port}", key))
            return f
        try:
            h = self.user("bo")
            f = helper(h)
            out = subprocess.run([sys.executable, str(f)], env=env, capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL)
            self.assertIn("All set", out.stdout, out.stdout + out.stderr)
            self.assertTrue((data / "axdio-discord.py").exists())
            self.assertIn("--background", autostart.read_text())
            self.assertTrue(wait(running), "the background copy didn't start")
            self.assertTrue(wait(lambda: "Showing what you play" in (data / "axdio-discord.log").read_text() if (data / "axdio-discord.log").exists() else False))
            # Opening it again replaces the running copy instead of starting a second one.
            out = subprocess.run([sys.executable, str(f)], env=env, capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL)
            self.assertIn("Replaced the copy that was already running", out.stdout)
            self.assertTrue(wait(running))
            out = subprocess.run([sys.executable, str(data / "axdio-discord.py"), "--uninstall"], env=env, capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL)
            self.assertIn("Removed", out.stdout)
            self.assertTrue(wait(lambda: not running()))
            self.assertFalse(autostart.exists() or (data / "axdio-discord.py").exists())

            # Turned off in Settings: the helper removes itself when it next checks in.
            f = helper(h)
            subprocess.run([sys.executable, str(f)], env=env, capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL)
            self.assertTrue(autostart.exists())
            self.assertTrue(wait(running))
            self.assertEqual(self.c.delete("/api/user/presence", headers=h).status_code, 200)
            subprocess.run([sys.executable, str(data / "axdio-discord.py"), "--stop"], env=env, capture_output=True, timeout=30)
            subprocess.Popen([sys.executable, str(data / "axdio-discord.py"), "--background"], env=env, stdin=subprocess.DEVNULL,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).wait(timeout=60)   # as at the next sign-in
            self.assertFalse(autostart.exists() or (data / "axdio-discord.py").exists())
            self.assertFalse(running())
        finally:
            if running():
                with socket.create_connection(("127.0.0.1", 47823), timeout=2) as c: c.sendall(b"axdio-stop")
            srv.shutdown()
            self.settings(discord_client_id="")

    def test_helper_and_feed(self):
        self.settings(discord_client_id="123456789012345678", discord_presence=True)
        try:
            h = self.user("rex")
            made = self.c.post("/api/user/presence", headers=h).get_json()
            compile(made["script"], "axdio-discord.py", "exec")
            key = re.search(r"KEY = '(axp_[^']+)'", made["script"]).group(1)
            feed = lambda: self.c.get("/api/presence", headers={"Authorization": "Bearer " + key})
            self.assertEqual(feed().get_json()["activity"], None)
            rel = self.rel("Opening")
            c = server.app.test_client()
            c.post("/api/auth/login", json={"username": "rex", "password": "long-password-1"})
            c.post("/api/player/now_playing", json={"src": "/api/stream_path?path=" + urllib.parse.quote(rel), "status": "STREAMING", "pos": 3})
            act = feed().get_json()["activity"]
            self.assertEqual((act["details"], act["state"], act["type"]), ("Opening", "Test Artist", 2))
            self.assertEqual(act["timestamps"]["end"] - act["timestamps"]["start"], 12)
            self.assertIn("/track/", act["assets"]["large_image"])
            c.post("/api/player/now_playing", json={"src": "/api/stream_path?path=" + urllib.parse.quote(rel), "status": "PAUSED", "pos": 5})
            self.assertIsNone(feed().get_json()["activity"])
            self.c.delete("/api/user/presence", headers=h)
            self.assertEqual(feed().status_code, 401)
        finally:
            self.settings(discord_client_id="")

    def test_helper_talks_to_discord(self):
        """The helper's Discord connection against a stand-in for the Discord app's local socket."""
        import socket as sk, struct, threading
        ns = {"__name__": "helper"}
        exec(server.presence_helper("https://music.example.com", "axp_test"), ns)
        run = TMP / "ipc"; run.mkdir(exist_ok=True)
        path = str(run / "discord-ipc-0")
        got = []
        srv = sk.socket(sk.AF_UNIX, sk.SOCK_STREAM); srv.bind(path); srv.listen(1)
        def fake_discord():
            conn, _ = srv.accept()
            def frame():
                op, n = struct.unpack("<II", conn.recv(8)); return op, json.loads(conn.recv(n))
            def send(op, d): b = json.dumps(d).encode(); conn.sendall(struct.pack("<II", op, len(b)) + b)
            got.append(frame()); send(1, {"cmd": "DISPATCH", "evt": "READY"})
            got.append(frame()); send(1, {"cmd": "SET_ACTIVITY", "evt": None, "data": {}})
            conn.close()
        t = threading.Thread(target=fake_discord, daemon=True); t.start()
        old = os.environ.get("XDG_RUNTIME_DIR"); os.environ["XDG_RUNTIME_DIR"] = str(run)
        try:
            d = ns["Discord"]()
            self.assertTrue(d.connect("123456789012345678"))
            d.set_activity({"type": 2, "details": "Opening", "state": "Test Artist"})
            d.close()
        finally:
            if old is None: os.environ.pop("XDG_RUNTIME_DIR", None)
            else: os.environ["XDG_RUNTIME_DIR"] = old
            t.join(5); srv.close()
        self.assertEqual(got[0], (0, {"v": 1, "client_id": "123456789012345678"}))
        self.assertEqual(got[1][0], 1)
        self.assertEqual(got[1][1]["cmd"], "SET_ACTIVITY")
        self.assertEqual(got[1][1]["args"]["activity"]["details"], "Opening")


def make_wheel(folder, name, version, files, requires=(), scripts=None):
    """A tiny wheel standing in for a real plugin, so installing one needs no network."""
    import base64 as b64, zipfile
    mod = name.replace("-", "_")
    info = f"{mod}-{version}.dist-info"
    files = dict(files)
    files[f"{info}/METADATA"] = "Metadata-Version: 2.1\nName: %s\nVersion: %s\n%s" % (name, version, "".join(f"Requires-Dist: {r}\n" for r in requires))
    files[f"{info}/WHEEL"] = "Wheel-Version: 1.0\nGenerator: axdio-tests\nRoot-Is-Purelib: true\nTag: py3-none-any\n"
    if scripts: files[f"{info}/entry_points.txt"] = "[console_scripts]\n" + "".join(f"{k} = {v}\n" for k, v in scripts.items())
    record = []
    for path, text in files.items():
        data = text.encode()
        digest = b64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
        record.append(f"{path},sha256={digest},{len(data)}")
    record.append(f"{info}/RECORD,,")
    files[f"{info}/RECORD"] = "\n".join(record) + "\n"
    whl = Path(folder) / f"{mod}-{version}-py3-none-any.whl"
    with zipfile.ZipFile(whl, "w") as z:
        for path, text in files.items(): z.writestr(path, text)
    return whl

FAKE_PLUGIN = """AXDIO_API = 1
AXDIO_MIN = "2.8.0"
VERSION = "%s"

def register(api):
    from flask import jsonify
    api.add_plugin("fake-tool", {"name": "Fake Tool", "package": "fake-tool", "license": "MIT", "part": True, "home": "https://example.com/tool", "desc": "Comes with it."})
    api.add_plugin("fake-extra", {"name": "Fake Extra", "package": "fake-extra", "license": "MIT", "command": "fake-extra", "home": "https://example.com/extra", "desc": "Optional."})
    api.settings({"id": "fakeplug", "title": "Fake plugin", "fields": [{"key": "fakeplug_on", "type": "bool", "label": "Fake switch", "default": True}]})
    api.route("hello")(lambda: jsonify({"hello": VERSION, "on": api.core.cfg().get("fakeplug_on")}))
    api.admin_page("fakepage", "Fake page", "plugins", "fake.js")
    api.hook("busy", lambda: False)
"""
FAKE_EXTRA = """import sys
def main():
    print("extra ok")
"""


class TestPlugins(Base):
    """Plugins are made separately: an admin installs, updates and removes them, and Axdio loads the Axdio ones."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.wheels = TMP / "wheels"
        cls.wheels.mkdir(exist_ok=True)
        cls.fake_plugin("1.0.0")
        make_wheel(cls.wheels, "fake-tool", "1.0.0", {"fake_tool/__init__.py": ""})
        make_wheel(cls.wheels, "fake-extra", "3.0.0", {"fake_extra/__init__.py": FAKE_EXTRA}, scripts={"fake-extra": "fake_extra:main"})
        cls.pip_args, server.PLUGIN_PIP_ARGS = server.PLUGIN_PIP_ARGS, ["--no-index", "--find-links", str(cls.wheels)]
        cls.latest, server.pypi_latest = server.pypi_latest, lambda pkg: {"axdio-fakeplug": "2.0.0", "fake-tool": "1.0.0", "fake-extra": "3.0.0"}[pkg]
        server.PLUGIN_CATALOG["fakeplug"] = {"name": "Fake Plugin", "package": "axdio-fakeplug", "module": "axdio_fakeplug", "axdio": True,
                                             "license": "MIT", "home": "https://example.com/fakeplug", "desc": "A plugin for the tests."}

    @classmethod
    def fake_plugin(cls, version):
        make_wheel(cls.wheels, "axdio-fakeplug", version, {"axdio_fakeplug/__init__.py": FAKE_PLUGIN % version,
                                                           "axdio_fakeplug/static/fake.js": "window.fakeLoaded = true;\n"}, requires=["fake-tool"])

    @classmethod
    def tearDownClass(cls):
        server.PLUGIN_PIP_ARGS, server.pypi_latest = cls.pip_args, cls.latest
        server.PLUGIN_CATALOG.pop("fakeplug", None)

    def run_job(self, a, pid, action):
        r = a.post(f"/api/admin/v2/plugins/{pid}", json={"action": action})
        self.assertEqual(r.status_code, 200, r.get_json())
        for _ in range(600):
            v = a.get("/api/admin/v2/plugins").get_json()
            if v["job"]["state"] != "running": break
            time.sleep(0.2)
        self.assertEqual(v["job"]["state"], "done", v["job"])
        return {p["id"]: p for p in v["plugins"]}

    def test_catalog(self):
        a = self.admin()
        v = {p["id"]: p for p in a.get("/api/admin/v2/plugins").get_json()["plugins"]}
        self.assertEqual((v["downloader"]["source"], v["downloader"]["installed"]), ("GitHub", None))
        self.assertNotIn("yt-dlp", v)                                   # the Downloader's own tools only come with it
        orig, server.plugin_latest = server.plugin_latest, lambda pid: "1.2.3"
        try:
            self.assertEqual(server._install_specs("downloader"), ["axdio-downloader @ https://github.com/xo907/axdio-downloader/archive/refs/tags/v1.2.3.tar.gz"])
        finally:
            server.plugin_latest = orig
        # Servers that had the downloader's tools installed before 2.8 are told where the downloader went.
        st = server.plugins_state()
        st["plugins"]["yt-dlp"] = {"auto_update": True, "installed": 1}
        server.plugins_save(st)
        try:
            self.assertTrue(a.get("/api/admin/v2/plugins").get_json()["downloader_moved"])
        finally:
            st["plugins"].pop("yt-dlp"); server.plugins_save(st)

    def test_install_update_remove(self):
        a = self.admin()
        self.assertEqual(a.get("/api/admin/plugins/fakeplug/hello").status_code, 404)
        v = self.run_job(a, "fakeplug", "install")
        self.assertEqual(v["fakeplug"]["installed"], "1.0.0")
        # Loaded at once: its route, admin page, settings and add-ons are there.
        self.assertEqual(a.get("/api/admin/plugins/fakeplug/hello").get_json(), {"hello": "1.0.0", "on": True})
        self.assertEqual(self.c.get("/api/admin/plugins/fakeplug/hello").status_code, 401)        # admins only
        pages = a.get("/api/admin/v2/plugins/ui").get_json()["pages"]
        self.assertEqual([(p["id"], p["script"]) for p in pages], [("fakepage", "/admin/plugins/fakeplug/fake.js")])
        r = a.get("/admin/plugins/fakeplug/fake.js")
        self.assertIn(b"fakeLoaded", r.data)
        r.close()
        self.assertEqual(self.c.get("/admin/plugins/fakeplug/fake.js").status_code, 404)
        self.assertEqual(a.get("/admin/plugins/fakeplug/../__init__.py").status_code, 404)
        self.assertIn("fakeplug", [s["id"] for s in a.get("/api/admin/v2/config").get_json()["schema"]])
        self.assertEqual((v["fake-tool"]["installed"], v["fake-tool"]["part"], v["fake-tool"]["addon_of"]), ("1.0.0", True, "Fake Plugin"))
        self.assertIsNone(v["fake-extra"]["installed"])
        r = a.post("/api/admin/v2/plugins/fake-tool", json={"action": "remove"})
        self.assertEqual(r.status_code, 409)
        self.assertIn("comes with Fake Plugin", r.get_json()["error"])

        # An optional add-on is installed on its own, and the plugin can't go while it needs it.
        with self.assertRaises(server.PluginMissing):
            with server.plugin_module_session("fake_extra", "fake-extra"): pass
        v = self.run_job(a, "fake-extra", "install")
        self.assertEqual(v["fake-extra"]["installed"], "3.0.0")
        self.assertEqual(subprocess.run([server.plugin_command("fake-extra")], capture_output=True, text=True, timeout=60).stdout.strip(), "extra ok")
        r = a.post("/api/admin/v2/plugins/fakeplug", json={"action": "remove"})
        self.assertEqual(r.status_code, 409)
        self.assertIn("Fake Extra needs Fake Plugin", r.get_json()["error"])
        v = self.run_job(a, "fake-extra", "remove")
        self.assertIsNone(v["fake-extra"]["installed"])

        # A newer version: found, installed, and loaded without restarting.
        self.fake_plugin("2.0.0")
        v = {p["id"]: p for p in a.post("/api/admin/v2/plugins/check").get_json()["plugins"]}
        self.assertTrue(v["fakeplug"]["update"])
        v = self.run_job(a, "fakeplug", "update")
        self.assertEqual(v["fakeplug"]["installed"], "2.0.0")
        self.assertEqual(a.get("/api/admin/plugins/fakeplug/hello").get_json()["hello"], "2.0.0")
        v = {p["id"]: p for p in a.post("/api/admin/v2/plugins/fakeplug", json={"auto_update": True}).get_json()["plugins"]}
        self.assertTrue(v["fakeplug"]["auto_update"])

        # Removing it takes everything it added, and what it brought along.
        v = self.run_job(a, "fakeplug", "remove")
        self.assertIsNone(v["fakeplug"]["installed"])
        self.assertNotIn("fake-tool", v)
        self.assertEqual(a.get("/api/admin/plugins/fakeplug/hello").status_code, 404)
        self.assertEqual(a.get("/api/admin/v2/plugins/ui").get_json()["pages"], [])
        self.assertNotIn("fakeplug", [s["id"] for s in a.get("/api/admin/v2/config").get_json()["schema"]])
        self.assertFalse(server.PLUGIN_ENV.exists())
        self.assertEqual(a.get("/api/admin/v2/system").get_json()["plugins"], {})

    def test_audit_repair_needs_the_downloader(self):
        rel = self.rel("Opening")
        with server.audit_lock: server.audit_db[rel] = {"status": "mismatch", "mtime": (MUSIC / rel).stat().st_mtime, "size": (MUSIC / rel).stat().st_size}
        try:
            server.audit_state["logs"].clear()
            self.assertFalse(server.repair_track(rel))
            self.assertIn("needs the Downloader plugin", "\n".join(server.audit_state["logs"]))
        finally:
            with server.audit_lock: server.audit_db.pop(rel, None)


class TestSharedMatching(Base):
    """Helpers the library audit shares with plugins."""
    def test_credits(self):
        self.assertTrue(server.same_credits(["Daft Punk", "Pharrell Williams", "Nile Rodgers"], "Get Lucky",
                                            "Daft Punk", "Get Lucky (feat. Pharrell Williams & Nile Rodgers)"))
        self.assertTrue(server.same_credits(["Dua Lipa"], "Levitating", "Dua Lipa", "Levitating"))
        self.assertFalse(server.same_credits(["Dua Lipa"], "Levitating", "Dua Lipa", "Levitating (feat. DaBaby)"))
        self.assertFalse(server.same_credits(["Adele"], "Hello", "Lionel Richie", "Hello"))
        # Catalogs often leave the featured artist out: the same recording, but not a library copy of it.
        self.assertTrue(server.same_credits(["The Weeknd", "Playboi Carti"], "Timeless (feat Playboi Carti)", "The Weeknd", "Timeless", strict=False))
        self.assertFalse(server.same_credits(["The Weeknd", "Playboi Carti"], "Timeless (feat Playboi Carti)", "The Weeknd", "Timeless"))
        self.assertFalse(server.same_credits(["Dua Lipa"], "Levitating", "Dua Lipa", "Levitating (feat. DaBaby)", strict=False))
        self.assertTrue(server.same_credits(["Tyler, The Creator"], "EARFQUAKE", "Tyler, The Creator", "EARFQUAKE"))


    def test_library_copies_need_the_same_artists(self):
        entries = {"Dua Lipa/Future Nostalgia/Levitating.flac": {"title": "Levitating", "artist": "Dua Lipa"},
                   "Dua Lipa/Moonlight/Levitating (feat. DaBaby).flac": {"title": "Levitating (feat. DaBaby)", "artist": "Dua Lipa"},
                   "The Weeknd/Starboy/Starboy.flac": {"title": "Starboy", "artist": "The Weeknd"}}
        for rel, v in entries.items():
            (MUSIC / rel).parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=duration=1", "-metadata", f"title={v['title']}",
                            "-metadata", f"artist={v['artist']}", str(MUSIC / rel)], check=True)
        with server.library_cache_lock:
            saved = dict(server.library_cache_data)
            server.library_cache_data.update(entries)
        try:
            copies = lambda title, artists: server.library_copies({"title": title, "artists": artists})
            self.assertEqual(copies("Levitating", ["Dua Lipa"]), ["Dua Lipa/Future Nostalgia/Levitating.flac"])
            self.assertEqual(copies("Levitating (feat. DaBaby)", ["Dua Lipa", "DaBaby"]), ["Dua Lipa/Moonlight/Levitating (feat. DaBaby).flac"])
            self.assertEqual(copies("Starboy", ["The Weeknd", "Daft Punk"]), ["The Weeknd/Starboy/Starboy.flac"])
            self.assertEqual(copies("Levitating", ["Someone Else"]), [])
            # A file tagged with both artists but no 'feat.' in its title is the other recording too.
            rel = "Dua Lipa/Club/Levitating.flac"
            (MUSIC / rel).parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=duration=1", "-metadata", "title=Levitating",
                            "-metadata", "artist=Dua Lipa;DaBaby", str(MUSIC / rel)], check=True)
            server.write_track_tags(MUSIC / rel, {"artists": ["Dua Lipa", "DaBaby"]})
            with server.library_cache_lock: server.library_cache_data[rel] = {"title": "Levitating", "artist": "Dua Lipa"}
            self.assertNotIn(rel, copies("Levitating", ["Dua Lipa"]))
            self.assertIn(rel, copies("Levitating", ["Dua Lipa", "DaBaby"]))
            (MUSIC / rel).unlink()
            # A copy that was deleted outside Axdio isn't one, and leaves the library.
            (MUSIC / "The Weeknd/Starboy/Starboy.flac").unlink()
            self.assertEqual(copies("Starboy", ["The Weeknd", "Daft Punk"]), [])
            self.assertNotIn("The Weeknd/Starboy/Starboy.flac", server.library_cache_data)
        finally:
            for rel in entries: (MUSIC / rel).unlink(missing_ok=True)
            with server.library_cache_lock:
                server.library_cache_data.clear()
                server.library_cache_data.update(saved)


class TestFilesAndLibrary(Social):
    """Changes made on the Files page reach the library at once, without a rescan."""
    def make(self, rel, title):
        p = MUSIC / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=500:duration=2",
                        "-metadata", f"title={title}", "-metadata", "artist=Mover", str(p)], check=True)
        server.refresh_library_entry(rel)
        return rel

    def test_delete_leaves_the_library_at_once(self):
        a = self.admin()
        one = self.make("Mover/Gone/01 - One.flac", "One")
        two = self.make("Mover/Gone/02 - Two.flac", "Two")
        keep = self.make("Mover/Kept/Stay.flac", "Stay")
        version = server.library_version
        server.audit_put(one, {"status": "ok"}, flush=True)
        r = a.post("/api/admin/files/delete", json={"path": "Mover/Gone"}).get_json()
        self.assertEqual(r["removed_songs"], 2)
        self.assertNotIn(one, server.library_cache_data)
        self.assertNotIn(two, server.library_cache_data)
        self.assertNotIn(one, server.audit_db)
        self.assertIn(keep, server.library_cache_data)
        self.assertNotEqual(server.library_version, version)              # the apps resync
        self.assertEqual(server.library_copies({"title": "One", "artists": ["Mover"]}), [])   # the downloader may fetch it again
        self.assertEqual(a.post("/api/admin/files/delete", json={"path": "../config"}).status_code, 403)
        a.post("/api/admin/files/delete", json={"path": "Mover"})

    def test_rename_keeps_likes_playlists_and_history(self):
        a = self.admin()
        h = self.user("rena")
        song = self.make("Mover/Old Album/01 - Song.flac", "Song")
        other = self.make("Mover/Old Album/02 - Other.flac", "Other")
        self.c.post("/api/user/sync", json={"liked_songs": [song], "playlists": {"Mix": [other, song]}}, headers=h)
        with server.users_lock: server.users_data["rena"]["history"] = [{"rel_path": song, "count": 3}]
        pl = self.c.post("/api/social/playlists", json={"name": "Together", "tracks": [song]}, headers=h).get_json()
        r = a.post("/api/admin/files/rename", json={"path": "Mover/Old Album", "new_name": "New Album"}).get_json()
        self.assertEqual(r["moved_songs"], 2)
        new_song, new_other = "Mover/New Album/01 - Song.flac", "Mover/New Album/02 - Other.flac"
        self.assertIn(new_song, server.library_cache_data)
        self.assertNotIn(song, server.library_cache_data)
        sync = self.c.get("/api/user/sync", headers=h).get_json()
        self.assertEqual(sync["liked_songs"], [new_song])
        self.assertEqual(sync["playlists"]["Mix"], [new_other, new_song])
        self.assertEqual(sync["history"][0]["rel_path"], new_song)
        tracks = [t["r"] for t in server._pl_get(pl["id"])["tracks"]] if hasattr(server, "_pl_get") else \
                 [t["r"] for p in server._pl_rows() if p["id"] == pl["id"] for t in p["tracks"]]
        self.assertEqual(tracks, [new_song])
        # A file: its extension stays, and nothing is overwritten.
        r = a.post("/api/admin/files/rename", json={"path": new_song, "new_name": "Renamed"}).get_json()
        self.assertEqual(r["new_name"], "Renamed.flac")
        self.assertIn("Mover/New Album/Renamed.flac", server.library_cache_data)
        self.assertEqual(a.post("/api/admin/files/rename", json={"path": "Mover/New Album/Renamed.flac", "new_name": "02 - Other.flac"}).status_code, 409)
        a.post("/api/admin/files/delete", json={"path": "Mover"})

    def test_songs_deleted_elsewhere_leave_when_played(self):
        rel = self.make("Mover/Elsewhere/Gone.flac", "Gone")
        (MUSIC / rel).unlink()
        self.assertEqual(self.c.get("/api/stream_path", query_string={"path": rel}).status_code, 404)
        for _ in range(50):
            if rel not in server.library_cache_data: break
            time.sleep(0.1)
        self.assertNotIn(rel, server.library_cache_data)


class TestAssetVersions(Base):
    def test_pages_point_at_the_current_files(self):
        r = self.c.get("/")
        html = r.get_data(as_text=True)
        stamps = re.findall(r"/web/(?:app|desktop)/[a-z]+\.js\?v=([0-9a-f]{10})", html)
        self.assertTrue(stamps, html[:500])
        self.assertNotIn("?v=3.2.0", html)
        js = self.c.get("/web/desktop/desktop.js")
        self.assertRegex(js.get_data(as_text=True), r"/web/app/core\.js\?v=[0-9a-f]{10}")
        again = self.c.get("/web/desktop/desktop.js", headers={"If-None-Match": js.headers["ETag"]})
        self.assertEqual(again.status_code, 304)
        # A changed file gets a new address (checked on a copy: the code may be read-only).
        web = TMP / "assets" / "web" / "app"
        web.mkdir(parents=True, exist_ok=True)
        (web / "x.js").write_text("1")
        orig = server.SCRIPT_DIR
        server.SCRIPT_DIR = TMP / "assets"
        try:
            first = server._asset_stamp("/web/app/x.js")
            os.utime(web / "x.js", ns=(0, 10**18))
            self.assertNotEqual(server._asset_stamp("/web/app/x.js"), first)
            self.assertIsNone(server._asset_stamp("/web/app/missing.js"))
        finally:
            server.SCRIPT_DIR = orig


class TestUpdates(Base):
    def test_versions_and_setup(self):
        self.assertEqual(server._split_ref("ghcr.io/xo907/axdio:2.4"), ("ghcr.io/xo907/axdio", "2.4"))
        self.assertEqual(server._split_ref("ghcr.io/xo907/axdio"), ("ghcr.io/xo907/axdio", "latest"))
        self.assertEqual(server._split_ref("localhost:5000/axdio@sha256:abc"), ("localhost:5000/axdio", "latest"))
        tags = TMP / "tags.json"
        tags.write_text(json.dumps({"tags": ["latest", "2.4", "2.4.0", "99.1.0", "99.0.3", "nightly"]}))
        os.environ["AXDIO_UPDATE_TAGS_URL"] = tags.as_uri()
        orig_notes, orig_api = server.release_notes, server.docker_api
        server.release_notes = lambda v: f"- Something new in {v}"
        try:
            a = self.admin()
            v = a.get("/api/admin/v2/updates?check=1").get_json()
            self.assertEqual((v["latest"], v["available"]), ("99.1.0", True))
            self.assertEqual([n["version"] for n in v["notes"]], ["99.1.0", "99.0.3"])
            self.assertEqual(v["setup"]["reason"], "no-socket")           # tests run without Docker
            self.assertEqual(a.post("/api/admin/v2/updates/install").status_code, 200)
            for _ in range(50):
                if server._update_job["state"] != "running": break
                time.sleep(0.1)
            self.assertEqual(server._update_job["state"], "error")          # nothing is changed without Docker
            # With Docker: which containers can update themselves.
            me = {"Id": "c" * 64, "Name": "/axdio", "Image": "sha256:old", "Config": {"Image": "ghcr.io/xo907/axdio:latest"},
                  "Mounts": [{"Destination": "/app/config", "Type": "bind", "Source": "/srv/axdio/config"}]}
            server.os.path.exists, orig_exists = (lambda p: True if p == server.DOCKER_SOCK else orig_exists(p)), server.os.path.exists
            try:
                server.docker_api = lambda m, path, body=None, **k: (200, me)
                self.assertTrue(server.update_setup()["can_update"])
                me["Mounts"].append({"Destination": "/app/server.py", "Type": "bind", "Source": "/src/server.py"})
                self.assertEqual(server.update_setup()["reason"], "dev")
                me["Mounts"].pop(); me["Config"]["Image"] = "axdio-local:latest"
                self.assertEqual(server.update_setup()["reason"], "other-image")
                def denied(*a, **k): raise PermissionError(13, "denied")
                server.docker_api = denied
                self.assertEqual(server.update_setup()["reason"], "no-permission")
            finally:
                server.os.path.exists = orig_exists
        finally:
            os.environ.pop("AXDIO_UPDATE_TAGS_URL", None)
            server.release_notes, server.docker_api = orig_notes, orig_api
            server._update_cache.update(checked=0, latest=None, versions=[])
            server._update_job.update(state="idle", message="")


class TestParties(Social):
    """Listening parties: one clock, one queue, everyone in sync."""
    def rels(self):
        return [self.rel("Opening"), self.rel("Second Song"), self.rel("Something Else")]

    def op(self, pid, h, **d):
        return self.c.post(f"/api/party/{pid}", json=d, headers=h)

    def tearDown(self):
        with server._party_cv:
            for p in list(server._parties.values()): server._party_end(p)

    def test_party_flow(self):
        ha, hb, hc = self.user("host1"), self.user("guest1"), self.user("guest2")
        one, two, three = self.rels()
        with server.library_cache_lock:
            server.library_cache_data[one]["duration"] = 12.0
            server.library_cache_data[two]["duration"] = 9.5
        v = self.c.post("/api/party", json={"name": "Friday", "queue": [one, two]}, headers=ha).get_json()
        pid, code = v["id"], v["code"]
        self.assertEqual((v["name"], v["state"]["rel"], v["state"]["playing"], v["is_host"]), ("Friday", one, True, True))
        self.assertEqual([q["r"] for q in v["queue"]], [two])
        self.assertEqual(self.c.post("/api/party/join", json={"code": "NOPE00"}, headers=hb).status_code, 404)
        g = self.c.post("/api/party/join", json={"code": code.lower()}, headers=hb).get_json()
        self.assertEqual(len(g["members"]), 2)
        self.assertFalse(g["can_control"]); self.assertTrue(g["can_add"])
        # Guests add but don't control (until the host says so).
        self.assertEqual(self.op(pid, hb, op="next").status_code, 403)
        self.assertEqual(self.op(pid, hb, op="add", rels=[three]).status_code, 200)
        self.assertEqual(self.op(pid, hb, op="settings", control=True).status_code, 403)
        self.op(pid, ha, op="settings", control=True)
        v = self.op(pid, hb, op="pause").get_json()
        self.assertFalse(v["state"]["playing"])
        pos = v["state"]["pos"]
        time.sleep(0.3)
        self.assertAlmostEqual(self.c.get(f"/api/party/{pid}/wait?rev=-1", headers=ha).get_json()["state"]["pos"], pos, places=2)   # paused: the clock stands still
        v = self.op(pid, hb, op="seek", pos=5).get_json()
        self.assertEqual(v["state"]["pos"], 5)
        self.op(pid, ha, op="resume")
        # A long poll answers as soon as something changes.
        rev = self.c.get(f"/api/party/{pid}/wait?rev=-1", headers=hb).get_json()["rev"]
        t0 = time.time()
        threading.Timer(0.5, lambda: self.op(pid, ha, op="react", emoji="🔥")).start()
        w = self.c.get(f"/api/party/{pid}/wait?rev={rev}", headers=hb).get_json()
        self.assertLess(time.time() - t0, 3)
        self.assertEqual(w["feed"][-1]["emoji"], "🔥")
        self.assertEqual(self.op(pid, hb, op="react", emoji="🍕").status_code, 400)
        # Chat is end-to-end encrypted: only ciphertext, under a key the members seal for each other.
        wrap = lambda by: dict(sealed(), e=b64(87), sig=b64(86), by=by)
        self.assertEqual(self.op(pid, hb, op="chat", text="great song").status_code, 400)                     # plain text: no
        self.assertEqual(self.op(pid, hb, op="chat", v=1, **sealed()).status_code, 400)                        # no key yet
        self.assertEqual(self.op(pid, hb, op="keys", v=1, wraps={"host1": wrap("host1")}).status_code, 400)    # sealed by someone else
        self.assertEqual(self.op(pid, ha, op="keys", v=1, wraps={"host1": wrap("host1"), "guest1": wrap("host1")}).status_code, 200)
        self.assertEqual(self.op(pid, hb, op="keys", v=2, wraps={"guest1": wrap("guest1")}).status_code, 409)  # only the host starts a new key
        seen = self.c.get(f"/api/party/{pid}/wait?rev=-1", headers=hb).get_json()
        self.assertEqual((seen["keyv"], seen["wrapped"], seen["my_wrap"]["by"]), (1, ["guest1", "host1"], "host1"))
        self.assertEqual(self.op(pid, hb, op="chat", v=1, **sealed()).status_code, 200)
        last = self.c.get(f"/api/party/{pid}/wait?rev=-1", headers=ha).get_json()["feed"][-1]
        self.assertEqual((last["kind"], last["v"], last["ct"], last.get("text")), ("chat", 1, sealed()["ct"], None))
        # The server moves on by itself at the end of the song.
        with server._party_cv:
            p = server._parties[pid]
            p["state"].update(pos=11.9, at=time.time())
        time.sleep(0.2)
        v = self.c.get(f"/api/party/{pid}/wait?rev=-1", headers=ha).get_json()
        self.assertEqual(v["state"]["rel"], two)
        self.assertEqual([q["r"] for q in v["queue"]], [three])
        v = self.op(pid, ha, op="prev").get_json()                  # back to the song before (it's been under 3 s)
        self.assertEqual(v["state"]["rel"], one)
        v = self.op(pid, hb, op="jump", id=v["queue"][-1]["id"]).get_json()
        self.assertEqual(v["state"]["rel"], three)
        # Host leaves: the next longest-standing member takes over; last one out ends the party.
        self.c.post("/api/party/join", json={"code": code}, headers=hc)
        self.op(pid, ha, op="leave")
        v = self.c.get(f"/api/party/{pid}/wait?rev=-1", headers=hb).get_json()
        self.assertEqual(v["host"], "guest1")
        self.assertEqual(self.op(pid, hc, op="kick", user="guest1").status_code, 403)
        self.op(pid, hb, op="kick", user="guest2")
        self.assertEqual(self.c.get(f"/api/party/{pid}/wait?rev=-1", headers=hc).status_code, 410)
        self.assertEqual(self.op(pid, hb, op="end").get_json(), {"ended": True})
        self.assertNotIn(pid, server._parties)

    def test_songs_play_to_the_end_by_themselves(self):
        ha = self.user("host2")
        one, two, _ = self.rels()
        with server.library_cache_lock:
            server.library_cache_data[one]["duration"] = 1.0
            server.library_cache_data[two]["duration"] = 30.0
        v = self.c.post("/api/party", json={"queue": [one, two]}, headers=ha).get_json()
        t0 = time.time()
        w = self.c.get(f"/api/party/{v['id']}/wait?rev={v['rev']}", headers=ha).get_json()   # wakes when the 1 s song ends
        self.assertLess(time.time() - t0, 2.5)
        self.assertEqual(w["state"]["rel"], two)

    def test_friends_see_and_join(self):
        ha, hb, hx = self.user("pal1"), self.user("pal2"), self.user("stranger1")
        self.friends("pal1", "pal2")
        v = self.c.post("/api/party", json={}, headers=ha).get_json()
        live = self.c.get("/api/party", headers=hb).get_json()["live"]
        self.assertEqual([p["id"] for p in live], [v["id"]])
        self.assertEqual(self.c.get("/api/party", headers=hx).get_json()["live"], [])
        self.assertEqual(self.c.post("/api/party/join", json={"id": v["id"]}, headers=hx).status_code, 404)    # needs the code
        act = self.c.get("/api/social/activity", headers=hb).get_json()["friends"]
        self.assertEqual(next(a for a in act if a["username"] == "pal1")["party"]["id"], v["id"])
        self.assertEqual(self.c.post("/api/party/join", json={"id": v["id"]}, headers=hb).status_code, 200)
        self.op(v["id"], ha, op="settings", visible=False)
        self.assertEqual(self.c.get("/api/party", headers=hb).get_json()["party"]["visible"], False)

    def test_turned_off(self):
        h = self.user("host3")
        self.settings(feature_party=False)
        try:
            self.assertEqual(self.c.post("/api/party", json={}, headers=h).status_code, 403)
            self.assertFalse(self.c.get("/api/library/cache").get_json()["settings"]["features"]["party"])
        finally:
            self.settings(feature_party=True)
        self.assertEqual(self.c.get("/party/abc123").headers["Location"], "/?party=ABC123")


class TestPrivateMedia(Social):
    def chat(self, a, b):
        ha, hb = self.friends(a, b)
        for h, tag in ((ha, "A"), (hb, "C")): self.c.post("/api/chat/keys", json=fake_keys(tag), headers=h)
        cid = self.c.post("/api/chat/dm", json={"username": b}, headers=ha).get_json()["id"]
        key = {"v": 1, "conv": cid, "by": a, "ts": 1, "ev": 0, "members": sorted([a, b]), "sig": b64(86),
               "wraps": {m: dict(sealed(), e=b64(87)) for m in (a, b)}, "fps": {m: "a" * 64 for m in (a, b)}}
        self.assertEqual(self.c.post(f"/api/chat/{cid}/keys", json={"key": key}, headers=ha).status_code, 200)
        return ha, hb, cid

    def upload(self, h, cid, size, kind="image"):
        r = self.c.post(f"/api/chat/{cid}/files", json={"kind": kind, "size": size}, headers=h)
        if r.status_code != 200: return r, None
        f = r.get_json()
        for n in range(f["chunks"]):
            n_bytes = (f["chunk"] if n < f["chunks"] - 1 else size - f["chunk"] * (f["chunks"] - 1)) + 16
            body = bytes([n % 251]) * n_bytes
            self.assertEqual(self.c.put(f"/api/chat/{cid}/files/{f['id']}/{n}", data=body, headers=h).status_code, 200)
        return self.c.post(f"/api/chat/{cid}/files/{f['id']}/done", headers=h), f

    def test_chats_live_in_their_own_folder(self):
        self.assertEqual(server.CHAT_DIR, CONFIG / "chat")
        self.assertTrue(server.CHAT_DB_FILE.is_file())
        with server._db_lock:
            main = {r[0] for r in server.db().execute("SELECT name FROM main.sqlite_master WHERE type = 'table'")}
            chat = {r[0] for r in server.db().execute("SELECT name FROM chat.sqlite_master WHERE type = 'table'")}
        self.assertFalse({"messages", "conversations", "conv_members"} & main)
        self.assertTrue({"messages", "conversations", "conv_members", "files"} <= chat)

    def test_older_chats_move_over(self):
        import sqlite3
        d = TMP / "migrate"
        d.mkdir()
        conn = sqlite3.connect(str(d / "axdio.db"), isolation_level=None)
        conn.execute("CREATE TABLE conversations (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated REAL)")
        conn.execute("CREATE TABLE conv_members (conv TEXT NOT NULL, user TEXT NOT NULL, read_seq INTEGER NOT NULL DEFAULT 0, hidden_seq INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (conv, user))")
        conn.execute("CREATE TABLE messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, conv TEXT NOT NULL, sender TEXT NOT NULL, ts REAL NOT NULL, data TEXT NOT NULL)")
        conn.execute("INSERT INTO conversations VALUES ('dm_x', '{}', 1)")
        conn.execute("INSERT INTO conv_members (conv, user) VALUES ('dm_x', 'a')")
        conn.executemany("INSERT INTO messages (id, conv, sender, ts, data) VALUES (?, 'dm_x', 'a', 1, '{}')", [("m1",), ("m2",)])
        saved = server.CHAT_DIR, server.CHAT_DB_FILE
        server.CHAT_DIR, server.CHAT_DB_FILE = d / "elsewhere", d / "elsewhere" / "chat.db"
        try:
            server._chat_attach(conn)
        finally:
            server.CHAT_DIR, server.CHAT_DB_FILE = saved
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0], 2)          # plain names now reach chat.db
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM chat.conv_members").fetchone()[0], 1)
        main = {r[0] for r in conn.execute("SELECT name FROM main.sqlite_master WHERE type = 'table'")}
        self.assertTrue(any(n.startswith("moved_messages_") for n in main))
        self.assertNotIn("messages", main)
        seq = conn.execute("INSERT INTO messages (id, conv, sender, ts, data) VALUES ('m3', 'dm_x', 'a', 2, '{}')").lastrowid
        self.assertEqual(seq, 3)
        conn.close()

    def test_encrypted_attachments_in_chunks(self):
        ha, hb, cid = self.chat("ivy", "jon")
        hs = self.user("kim")
        size = server.CHAT_CHUNK + 1000
        r = self.c.post(f"/api/chat/{cid}/files", json={"kind": "image", "size": size}, headers=ha)
        f = r.get_json()
        self.assertEqual(f["chunks"], 2)
        self.assertEqual(self.c.put(f"/api/chat/{cid}/files/{f['id']}/0", data=b"x" * 10, headers=ha).status_code, 400)
        self.assertEqual(self.c.put(f"/api/chat/{cid}/files/{f['id']}/0", data=b"x" * (server.CHAT_CHUNK + 16), headers=hb).status_code, 403)
        self.assertEqual(self.c.put(f"/api/chat/{cid}/files/{f['id']}/0", data=b"x" * (server.CHAT_CHUNK + 16), headers=ha).status_code, 200)
        self.assertEqual(self.c.post(f"/api/chat/{cid}/files/{f['id']}/done", headers=ha).status_code, 409)   # chunk 1 missing
        self.assertEqual(self.c.get(f"/api/chat/{cid}/files/{f['id']}/0", headers=hb).status_code, 404)       # not finished
        self.assertEqual(self.c.put(f"/api/chat/{cid}/files/{f['id']}/1", data=b"y" * 1016, headers=ha).status_code, 200)
        self.assertEqual(self.c.post(f"/api/chat/{cid}/files/{f['id']}/done", headers=ha).status_code, 200)
        self.assertTrue((server.CHAT_MEDIA_DIR / f["id"][:2] / f["id"] / "1.bin").is_file())
        msg = dict(sealed(), id="p" * 20, v=1, sig=b64(86), files=[f["id"]])
        self.assertEqual(self.c.post(f"/api/chat/{cid}/messages", json=dict(msg, files=["z" * 22]), headers=ha).status_code, 400)
        self.assertEqual(self.c.post(f"/api/chat/{cid}/messages", json=msg, headers=ha).status_code, 200)
        self.assertEqual(self.c.post(f"/api/chat/{cid}/messages", json=dict(msg, id="q" * 20), headers=ha).status_code, 400)  # already used
        got = self.c.get(f"/api/chat/{cid}/files/{f['id']}/1", headers=hb)
        self.assertEqual((got.status_code, got.data), (200, b"y" * 1016))
        self.assertIn("immutable", got.headers["Cache-Control"])
        got.close()
        self.assertEqual(self.c.get(f"/api/chat/{cid}/files/{f['id']}/1", headers=hs).status_code, 404)       # not in the chat
        stats = server.social_stats()
        self.assertGreaterEqual(stats["media_bytes"], size)
        self.assertEqual(self.c.delete(f"/api/chat/{cid}/messages/{msg['id']}", headers=ha).status_code, 200)  # unsending removes it
        self.assertEqual(self.c.get(f"/api/chat/{cid}/files/{f['id']}/1", headers=hb).status_code, 404)
        self.assertFalse((server.CHAT_MEDIA_DIR / f["id"][:2] / f["id"]).exists())

    def test_admin_limits(self):
        ha, hb, cid = self.chat("lou", "max")
        try:
            self.settings(chat_media_videos=False, chat_media_max_mb=1, chat_media_quota_mb=2)
            branding = self.c.get("/api/branding", headers=ha).get_json()["settings"]["chat_media"]
            self.assertEqual((branding["video"], branding["image"], branding["max"], branding["chunk"]), (False, True, 1024 * 1024, server.CHAT_CHUNK))
            self.assertEqual(self.c.post(f"/api/chat/{cid}/files", json={"kind": "video", "size": 10}, headers=ha).status_code, 403)
            self.assertEqual(self.c.post(f"/api/chat/{cid}/files", json={"kind": "image", "size": 2 * 1024 * 1024}, headers=ha).status_code, 413)
            self.assertEqual(self.c.post(f"/api/chat/{cid}/files", json={"kind": "exe", "size": 10}, headers=ha).status_code, 400)
            r, _ = self.upload(ha, cid, 1024 * 1024)
            self.assertEqual(r.status_code, 200)
            r = self.c.post(f"/api/chat/{cid}/files", json={"kind": "image", "size": 1024 * 1024}, headers=ha)
            self.assertEqual(r.status_code, 200)                     # exactly at the quota (unfinished uploads count too)
            r = self.c.post(f"/api/chat/{cid}/files", json={"kind": "voice", "size": 1000}, headers=ha)
            self.assertEqual((r.status_code, r.get_json().get("quota")), (413, True))
            self.assertEqual(self.c.post(f"/api/chat/{cid}/files", json={"kind": "voice", "size": 1000}, headers=hb).status_code, 200)   # per listener
        finally:
            self.settings(chat_media_videos=True, chat_media_max_mb=100, chat_media_quota_mb=2048)

    def test_disappearing_messages(self):
        ha, hb, cid = self.chat("ned", "ola")
        self.assertEqual(self.c.post(f"/api/chat/{cid}/ttl", json={"ttl": 5}, headers=ha).status_code, 400)
        conv = self.c.post(f"/api/chat/{cid}/ttl", json={"ttl": 3600}, headers=hb).get_json()
        self.assertEqual((conv["ttl"], conv["ttl_log"][-1]["by"]), (3600, "ola"))
        sent = self.c.post(f"/api/chat/{cid}/messages", json=dict(sealed(), id="d" * 20, v=1, sig=b64(86)), headers=ha).get_json()["message"]
        self.assertAlmostEqual(sent["expires"], sent["ts"] + 3600, delta=1)
        self.assertEqual(len(self.c.get(f"/api/chat/{cid}/messages", headers=hb).get_json()["messages"]), 1)
        with server._db_lock: server.db().execute("UPDATE messages SET expires = ? WHERE id = ?", (time.time() - 1, "d" * 20))
        self.assertEqual(self.c.get(f"/api/chat/{cid}/messages", headers=hb).get_json()["messages"], [])
        self.c.post(f"/api/chat/{cid}/ttl", json={"ttl": 0}, headers=ha)
        later = self.c.post(f"/api/chat/{cid}/messages", json=dict(sealed(), id="e" * 20, v=1, sig=b64(86)), headers=ha).get_json()["message"]
        self.assertNotIn("expires", later)

    def test_blend_with_a_friend(self):
        ha, hb = self.friends("pia", "quin")
        one, two, three = self.rel("Opening"), self.rel("Second Song"), self.rel("Something Else")
        with server.users_lock:
            server.users_data["pia"]["history"] = [{"rel_path": r, "count": 3, "last_played": "2026-09-01"} for r in (one, two)]
            server.users_data["pia"]["liked_songs"] = [one, two, three]
            server.users_data["quin"]["history"] = [{"rel_path": one, "count": 9, "last_played": "2026-09-02"}]
            server.users_data["quin"]["liked_songs"] = [one, three, two]
        b = self.c.get("/api/social/users/quin", headers=ha).get_json()["blend"]
        self.assertGreater(b["match"], 50)
        self.assertEqual(b["rels"][0], one)                         # both play it most
        self.assertEqual(sorted(b["rels"]), sorted([one, two, three]))
        self.assertIn("Test Artist", b["common"])
        self.c.post("/api/social/settings", json={"share_activity": False}, headers=ha)
        self.assertNotIn("blend", self.c.get("/api/social/users/quin", headers=ha).get_json())    # keeps theirs private → no blend
        self.c.post("/api/social/settings", json={"share_activity": True}, headers=ha)


class TestRewind(Social):
    def test_year_in_music(self):
        h = self.user("rae")
        one, two, three = self.rel("Opening"), self.rel("Second Song"), self.rel("Something Else")
        for rel, n in ((one, 4), (two, 2), (three, 1)):
            for _ in range(n): self.c.post("/api/user/record_play", json={"rel_path": rel}, headers=h)
        r = self.c.get("/api/rewind?period=year&tz=0", headers=h).get_json()
        self.assertEqual((r["plays"], r["songs"], r["artists"]), (7, 3, 2))
        self.assertEqual(r["top_songs"][0]["rel"], one)
        self.assertEqual(r["top_songs"][0]["plays"], 4)
        self.assertEqual(r["top_artists"][0]["name"], "Test Artist")
        self.assertEqual(r["minutes"], round((12.0 * 4 + 9.5 * 2 + 7.25) / 60))
        self.assertEqual(sum(r["hours"]), 7)
        self.assertIn(r["persona"]["name"], {"Early bird", "Daydreamer", "Golden hour", "Night owl"})
        self.assertEqual((r["streak"], r["active_days"], r["discoveries"]), (1, 1, 3))
        self.assertEqual(r["on_repeat"]["rel"], one)
        self.assertIn(time.gmtime().tm_year, r["years"])
        empty = self.c.get("/api/rewind?period=month&y=2001&m=2&tz=0", headers=h).get_json()
        self.assertEqual((empty["plays"], empty["label"]), (0, "February 2001"))
        log = json.loads(self.c.get("/api/user/export", headers=h).data)["account"]["listening_log"]
        self.assertEqual(len(log), 7)

    def test_history_is_brought_in_once(self):
        h = self.user("sol")
        rel = self.rel("Second Song")
        with server.users_lock:
            server.users_data["sol"]["history"] = [{"rel_path": rel, "count": 5, "last_played": "2025-03-02T21:30:00"}]
        with server._db_lock: server.db().execute("DELETE FROM kv WHERE key = 'plays_backfilled'")
        server.rewind_backfill()
        server.rewind_backfill()   # a second run changes nothing
        r = self.c.get("/api/rewind?period=year&y=2025&tz=0", headers=h).get_json()
        self.assertEqual((r["plays"], r["top_songs"][0]["rel"], sum(r["hours"])), (5, rel, 0))   # no time of day from old history
        self.assertNotIn("persona", r)
        self.assertEqual(self.c.get("/api/rewind?period=month&y=2025&m=3&tz=0", headers=h).get_json()["plays"], 5)

    def test_gone_with_the_account_and_switch(self):
        h = self.user("tam")
        self.c.post("/api/user/record_play", json={"rel_path": self.rel("Opening")}, headers=h)
        try:
            self.settings(feature_rewind=False)
            self.assertEqual(self.c.get("/api/rewind", headers=h).status_code, 403)
            self.assertFalse(self.c.get("/api/branding").get_json()["settings"]["features"]["rewind"])
        finally:
            self.settings(feature_rewind=True)
        self.assertEqual(self.c.post("/api/user/delete_account", json={"password": "long-password-1"}, headers=h).status_code, 200)
        with server._db_lock:
            self.assertEqual(server.db().execute("SELECT COUNT(*) FROM plays WHERE user = 'tam'").fetchone()[0], 0)

    def test_collab_switch_blocks_the_api(self):
        h = self.user("uma")
        try:
            self.settings(feature_collab=False)
            self.assertEqual(self.c.get("/api/social/playlists", headers=h).status_code, 403)
        finally:
            self.settings(feature_collab=True)
        self.assertEqual(self.c.get("/api/social/playlists", headers=h).status_code, 200)


class TestSmartTransitions(Base):
    def test_measuring_a_song(self):
        f = TMP / "shape.flac"
        # 1.5 s of silence, a tone that fades out from 7.5 s to 9.5 s, then 2 s of silence.
        expr = "if(between(t,1.5,9.5),0.5*sin(2*PI*440*t)*if(gt(t,7.5),(9.5-t)/2,1),0)"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "aevalsrc=" + expr.replace(",", "\\,") + ":s=44100:d=11.5", str(f)], check=True)
        a = server.measure_song(f)
        self.assertAlmostEqual(a["dur"], 11.5, delta=.3)
        self.assertTrue(1.3 <= a["start"] <= 1.5, a)
        self.assertTrue(9.4 <= a["end"] <= 9.8, a)
        self.assertTrue(7.6 <= a["outro"] <= 8.4, a)
        self.assertLess(a["lufs"], -3)

    def test_measured_in_the_background_and_cached(self):
        rel = self.rel("Something Else")
        first = self.c.get("/api/analysis", query_string={"rel": rel, "now": rel}).get_json()["analysis"]
        self.assertIn(rel, first)
        for _ in range(60):
            got = self.c.get("/api/analysis", query_string={"rel": rel}).get_json()["analysis"][rel]
            if got: break
            time.sleep(.5)
        self.assertAlmostEqual(got["dur"], 7.25, delta=.3)
        self.assertLess(got["start"], .3)
        self.assertEqual(self.c.get("/api/analysis", query_string={"rel": "@rabcdef/x.flac"}).get_json()["analysis"], {})
        try:
            self.settings(feature_smart=False)
            self.assertTrue(self.c.get("/api/analysis", query_string={"rel": rel}).get_json()["off"])
        finally:
            self.settings(feature_smart=True)


class TestDaily(Social):
    def test_a_day_of_guessing(self):
        ha, hb = self.friends("vera", "walt")
        v = self.c.get("/api/daily", headers=ha).get_json()
        self.assertEqual((v["number"], v["stage"], v["tries"], v["done"]), ((server.daily_today() - server.DAILY_EPOCH).days + 1, 0, [], False))
        self.assertTrue(v["ready"])
        self.assertNotIn("answer", v)
        answer = server.daily_pick(server.daily_today())
        self.assertEqual(server.daily_pick(server.daily_today()), answer)          # fixed for the day
        clip = self.c.get("/api/daily/clip?stage=0", headers=ha)
        self.assertEqual((clip.status_code, clip.mimetype), (200, "audio/mpeg"))
        clip.close()
        self.assertEqual(self.c.get("/api/daily/clip?stage=1", headers=ha).status_code, 403)   # not unlocked yet
        wrong = next(r for r in (self.rel("Opening"), self.rel("Second Song"), self.rel("Something Else")) if r != answer["rel"])
        v = self.c.post("/api/daily/guess", json={"rel": wrong}, headers=ha).get_json()
        self.assertEqual((v["stage"], v["tries"][0]["r"]), (1, "wrong"))
        self.assertEqual(self.c.get("/api/daily/clip?stage=1", headers=ha).status_code, 200)
        self.assertEqual(self.c.post("/api/daily/guess", json={"rel": "nope.flac"}, headers=ha).status_code, 400)
        self.c.post("/api/daily/guess", json={"skip": True}, headers=ha)
        v = self.c.post("/api/daily/guess", json={"rel": answer["rel"]}, headers=ha).get_json()
        self.assertTrue(v["done"] and v["solved"])
        self.assertEqual(v["answer"]["rel"], answer["rel"])
        self.assertEqual((v["stats"]["streak"], v["stats"]["wins"], v["stats"]["dist"][2]), (1, 1, 1))
        again = self.c.post("/api/daily/guess", json={"skip": True}, headers=ha).get_json()
        self.assertEqual(len(again["tries"]), 3)                                    # finished: nothing changes
        for _ in range(6): v = self.c.post("/api/daily/guess", json={"skip": True}, headers=hb).get_json()
        self.assertTrue(v["done"] and not v["solved"])
        self.assertEqual(v["stats"]["streak"], 0)
        self.assertEqual(self.c.get("/api/daily/clip?stage=5", headers=hb).status_code, 200)
        mine = self.c.get("/api/daily", headers=ha).get_json()["friends"][0]
        self.assertEqual((mine["username"], mine["n"], mine["solved"], mine["grid"]), ("walt", 6, False, ["skip"] * 6))

    def test_streaks_and_switch(self):
        h = self.user("xena")
        today = server.daily_today()
        with server._db_lock:
            for k, solved in ((3, 1), (2, 1), (1, 1)):
                server.db().execute("INSERT INTO daily (user, day, tries, done, solved, n) VALUES ('xena', ?, '[]', 1, ?, 2)",
                                    ((today - server.timedelta(days=k)).isoformat(), solved))
        self.assertEqual(self.c.get("/api/daily", headers=h).get_json()["stats"]["streak"], 3)
        with server._db_lock: server.db().execute("DELETE FROM daily WHERE user = 'xena' AND day = ?", ((today - server.timedelta(days=1)).isoformat(),))
        self.assertEqual(self.c.get("/api/daily", headers=h).get_json()["stats"]["streak"], 0)   # yesterday missed
        try:
            self.settings(feature_daily=False)
            self.assertEqual(self.c.get("/api/daily", headers=h).status_code, 403)
        finally:
            self.settings(feature_daily=True)


class TestDiscover(Social):
    def test_finding_the_hook(self):
        f = TMP / "hook.flac"
        # Quiet verses, a loud chorus from 30 s to 45 s, quiet again.
        expr = "sin(2*PI*330*t)*if(between(t,30,45),0.8,0.08)"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "aevalsrc=" + expr.replace(",", "\\,") + ":s=44100:d=70", str(f)], check=True)
        a = server.measure_song(f)
        self.assertAlmostEqual(a["hook"], 30, delta=1.5)

    def test_a_feed_of_new_songs(self):
        ha, hb = self.friends("yuri", "zoe")
        one, two, three = self.rel("Opening"), self.rel("Second Song"), self.rel("Something Else")
        self.c.post("/api/user/record_play", json={"rel_path": one}, headers=ha)
        for _ in range(3): self.c.post("/api/user/record_play", json={"rel_path": three}, headers=hb)
        items = self.c.get("/api/discover?n=5", headers=ha).get_json()["items"]
        rels = [i["rel"] for i in items]
        self.assertNotIn(one, rels)                                   # already played
        self.assertEqual(sorted(rels), sorted([two, three]))
        pick = next(i for i in items if i["rel"] == three)
        self.assertEqual((pick["why"]["kind"], pick["why"]["user"]), ("friend", "zoe"))
        self.assertIn("has it on repeat", pick["why"]["text"])
        self.assertGreaterEqual(pick["hook"], 0)
        again = [i["rel"] for i in self.c.get("/api/discover?n=5", headers=ha).get_json()["items"]]
        self.assertEqual(sorted(again), sorted([two, three]))         # everything seen: it goes round again
        self.assertEqual(self.c.post("/api/discover/log", json={"action": "like", "rel": two}, headers=ha).status_code, 200)
        self.assertEqual(self.c.post("/api/discover/log", json={"action": "hack"}, headers=ha).status_code, 400)
        with server._db_lock:
            self.assertEqual(server.db().execute("SELECT COUNT(*) FROM events WHERE user = 'yuri' AND kind = 'discover_like'").fetchone()[0], 1)
        self.c.post("/api/social/settings", json={"share_activity": False}, headers=hb)
        pick = next(i for i in self.c.get("/api/discover?n=5", headers=ha).get_json()["items"] if i["rel"] == three)
        self.assertNotEqual(pick["why"]["kind"], "friend")            # zoe keeps her listening to herself now
        self.c.post("/api/social/settings", json={"share_activity": True}, headers=hb)


class TestAchievements(Social):
    def test_levels_streaks_and_badges(self):
        ha, hb = self.friends("abe", "bo")
        one, two = self.rel("Opening"), self.rel("Something Else")
        for _ in range(5): self.c.post("/api/user/record_play", json={"rel_path": one}, headers=ha)
        self.c.post("/api/user/record_play", json={"rel_path": two}, headers=ha)
        # A time zone where it's midday now, so only the plays put at 2 am there count as night listening.
        now = time.time()
        tz = (int(now // 3600) % 24 - 12) * 60
        local = now - tz * 60
        night = local - local % 86400 + 2 * 3600 + tz * 60
        with server._db_lock:
            server.db().execute("INSERT INTO plays (user, ts, rel, secs, n, b) VALUES ('abe', ?, ?, 600, 10, 0)", (night, one))
            server.db().execute("INSERT INTO daily (user, day, tries, done, solved, n) VALUES ('abe', '2026-01-01', '[]', 1, 1, 1)")
        server.events_add("abe", "party_host", "pty_x")
        server._ach_cache.clear()
        a = self.c.get(f"/api/achievements?tz={tz}", headers=ha).get_json()
        badge = {b["id"]: b for b in a["badges"]}
        self.assertEqual(len(a["badges"]), len(server.BADGES))
        self.assertEqual((a["streak"], a["played_today"]), (1, True))
        self.assertGreaterEqual(a["xp"], 100 + 25 + 50 + 30)             # 100 night minutes, a Daily win from 1 s, a party
        self.assertEqual(a["level"], server.xp_level(a["xp"])[0])
        self.assertEqual((badge["night_owl"]["value"], badge["night_owl"]["tier"], badge["night_owl"]["next"]), (10, 1, 50))
        self.assertEqual((badge["on_repeat"]["value"], badge["on_repeat"]["tier"], badge["explorer"]["value"]), (15, 2, 2))   # 5 + the 10 at night, same day
        self.assertEqual((badge["perfect_pitch"]["tier"], badge["party"]["tier"], badge["social"]["value"]), (1, 1, 1))
        prof = self.c.get("/api/social/users/abe", headers=hb).get_json()["achievements"]
        self.assertEqual(prof["level"], a["level"])
        self.assertTrue(prof["badges"] and all(b["tier"] for b in prof["badges"]))
        self.c.post("/api/social/settings", json={"share_activity": False}, headers=ha)
        self.assertNotIn("achievements", self.c.get("/api/social/users/abe", headers=hb).get_json())
        self.c.post("/api/social/settings", json={"share_activity": True}, headers=ha)

    def test_level_curve(self):
        self.assertEqual(server.xp_level(0)[0], 1)
        self.assertEqual(server.xp_level(60)[0], 2)
        self.assertEqual(server.xp_level(59)[0], 1)
        self.assertEqual(server.xp_level(1620)[0], 10)


class TestNotes(Social):
    def test_notes_for_friends(self):
        ha, hb = self.friends("cleo", "dex")
        hc = self.user("eli")
        rel = self.rel("Opening")
        r = self.c.post("/api/social/note", json={"text": "  this  song  on repeat all day long, no regrets at all whatsoever  ", "rel": rel}, headers=ha).get_json()
        self.assertEqual(len(r["note"]["text"]), 60)
        self.assertEqual((r["note"]["rel"], r["note"]["title"]), (rel, "Opening"))
        got = self.c.get("/api/social/notes", headers=hb).get_json()
        self.assertEqual([f["username"] for f in got["friends"]], ["cleo"])
        self.assertIsNone(got["mine"])
        self.assertEqual(self.c.get("/api/social/notes", headers=hc).get_json()["friends"], [])       # not a friend
        self.c.post("/api/social/note", json={"text": "hi", "rel": "nope.flac"}, headers=hb)
        self.assertNotIn("rel", self.c.get("/api/social/notes", headers=hb).get_json()["mine"])     # unknown songs are dropped
        with server.users_lock: server.users_data["cleo"]["note"]["until"] = time.time() - 1
        self.assertEqual(self.c.get("/api/social/notes", headers=hb).get_json()["friends"], [])       # 24 hours are up
        self.c.post("/api/social/note", json={"clear": True}, headers=hb)
        self.assertIsNone(self.c.get("/api/social/notes", headers=hb).get_json()["mine"])
        try:
            self.settings(feature_notes=False)
            self.assertEqual(self.c.post("/api/social/note", json={"text": "x"}, headers=ha).status_code, 403)
        finally:
            self.settings(feature_notes=True)


class TestChartAndCapsule(Social):
    def test_friends_chart(self):
        ha, hb = self.friends("fae", "gil")
        hc = self.user("hal2")
        one, two, three = self.rel("Opening"), self.rel("Second Song"), self.rel("Something Else")
        play = lambda h, rel, n: [self.c.post("/api/user/record_play", json={"rel_path": rel}, headers=h) for _ in range(n)]
        play(ha, one, 3); play(hb, one, 2); play(hb, two, 4); play(hc, three, 9)       # hal2 isn't a friend
        with server._db_lock:                                                            # last week, two was on top
            server.db().execute("INSERT INTO plays (user, ts, rel, secs, n, b) VALUES ('gil', ?, ?, 60, 20, 0)", (time.time() - 10 * 86400, two))
        ch = self.c.get("/api/social/chart", headers=ha).get_json()
        self.assertEqual([i["rel"] for i in ch["items"]], [one, two])                    # 5 plays by two people beat 4 by one
        top = ch["items"][0]
        self.assertEqual((top["rank"], top["prev"], top["plays"], top["n_listeners"]), (1, None, 5, 2))
        self.assertEqual(ch["items"][1]["prev"], 1)
        self.assertEqual(top["listeners"][0]["username"], "fae")
        self.c.post("/api/social/settings", json={"share_activity": False}, headers=hb)
        self.assertEqual([i["rel"] for i in self.c.get("/api/social/chart", headers=ha).get_json()["items"]], [one])
        self.c.post("/api/social/settings", json={"share_activity": True}, headers=hb)

    def test_time_capsule(self):
        h = self.user("ida")
        one, two = self.rel("Opening"), self.rel("Second Song")
        now = time.time()
        with server._db_lock:
            server.db().execute("INSERT INTO plays (user, ts, rel, secs, n, b) VALUES ('ida', ?, ?, 60, 2, 0)", (now - 365 * 86400, one))
            server.db().execute("INSERT INTO plays (user, ts, rel, secs, n, b) VALUES ('ida', ?, ?, 60, 6, 1)", (now - 90 * 86400, two))
        tc = self.c.get("/api/timecapsule?tz=0", headers=h).get_json()
        if tc["years"]:                                                                   # (not when last year had no 29 February)
            self.assertEqual((tc["years"][0]["ago"], tc["years"][0]["songs"][0]["rel"]), (1, one))
        self.assertEqual([s["rel"] for s in tc["rediscover"]], [two])                   # 6 plays, none for 90 days
        self.assertEqual(tc["rediscover"][0]["plays"], 6)


class TestSecretChats(Social):
    def dev(self, i): return {"id": (i * 16)[:16], "enc": b64(87, "E"), "sig": b64(87, "S"), "cert": b64(86), "label": "Phone"}

    def test_one_device_each(self):
        ha, hb = self.friends("jo", "kai")
        for h, tag in ((ha, "A"), (hb, "C")): self.c.post("/api/chat/keys", json=fake_keys(tag), headers=h)
        self.assertEqual(self.c.post("/api/chat/secret", json={"username": "kai", "device": {"id": "x"}}, headers=ha).status_code, 400)
        self.assertEqual(self.c.post("/api/chat/secret", json={"username": "lu", "device": self.dev("a")}, headers=ha).status_code, 404)
        c = self.c.post("/api/chat/secret", json={"username": "kai", "device": self.dev("a")}, headers=ha).get_json()
        cid = c["id"]
        self.assertTrue(cid.startswith("sc_"))
        self.assertEqual((c["kind"], list(c["devices"])), ("secret", ["jo"]))
        key = lambda by, dev, v=1: {"v": v, "conv": cid, "by": by, "ts": 1, "ev": 0, "members": ["jo", "kai"], "sig": b64(86), "dev": dev, "dsig": b64(86),
                                    "wraps": {m: dict(sealed(), e=b64(87)) for m in ("jo", "kai")}, "fps": {m: "a" * 64 for m in ("jo", "kai")}}
        self.assertEqual(self.c.post(f"/api/chat/{cid}/keys", json={"key": key("jo", "a" * 16)}, headers=ha).status_code, 409)   # kai hasn't opened it
        self.assertEqual(self.c.post(f"/api/chat/{cid}/accept", json={"device": self.dev("b")}, headers=ha).status_code, 409)   # jo's side is taken
        acc = self.c.post(f"/api/chat/{cid}/accept", json={"device": self.dev("b")}, headers=hb).get_json()
        self.assertEqual(acc["devices"]["kai"]["id"], "b" * 16)
        self.assertEqual(self.c.post(f"/api/chat/{cid}/accept", json={"device": self.dev("c")}, headers=hb).status_code, 409)   # once only
        self.assertEqual(self.c.post(f"/api/chat/{cid}/keys", json={"key": key("jo", "z" * 16)}, headers=ha).status_code, 403)   # another device of jo's
        self.assertEqual(self.c.post(f"/api/chat/{cid}/keys", json={"key": key("jo", "a" * 16)}, headers=ha).status_code, 200)
        stored = self.c.get(f"/api/chat/{cid}", headers=hb).get_json()["keys"][0]
        self.assertEqual((stored["dev"], stored["dsig"]), ("a" * 16, b64(86)))
        msg = dict(sealed(), id="s" * 20, v=1, sig=b64(86))
        self.assertEqual(self.c.post(f"/api/chat/{cid}/messages", json=msg, headers=hb).status_code, 200)
        self.assertEqual(len(self.c.get(f"/api/chat/{cid}/messages", headers=ha).get_json()["messages"]), 1)
        self.assertEqual(self.c.get(f"/api/chat/{cid}", headers=self.user("mo")).status_code, 404)                                # not in it


class TestMoments(Base):
    def test_shared_moment_opens_at_that_second(self):
        rel = self.rel("Opening")
        sid = server.share_id("t", rel)
        r = self.c.get(f"/track/{sid}/open?t=73")
        self.assertEqual(r.status_code, 302)
        self.assertTrue(r.headers["Location"].endswith("&t=73"), r.headers["Location"])
        self.assertNotIn("t=", self.c.get(f"/track/{sid}/open").headers["Location"])
        self.assertNotIn("t=", self.c.get(f"/track/{sid}/open?t=999999").headers["Location"])   # nonsense ignored


def tearDownModule():
    shutil.rmtree(TMP, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
