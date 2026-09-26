
def get_app_template():
    from flask import request
    # Set by the mobile app's "Switch to desktop site"; visiting /mobile clears it.
    if request.cookies.get('axdio_view') == 'desktop':
        return 'app.html'
    ua = request.headers.get('User-Agent', '').lower()
    is_mob = any(k in ua for k in ['iphone', 'android', 'mobile', 'touch', 'ipod'])
    return 'mobile.html' if is_mob else 'app.html'

import os, sys, re, json, time, threading, subprocess, shutil, base64, urllib.parse, urllib.request, io, hashlib, secrets, ssl, hmac, gzip, random
from pathlib import Path
from datetime import datetime
from functools import wraps
from collections import Counter

from flask import Flask, render_template, request, jsonify, Response, send_file, abort, redirect, session, url_for

try:
    from mutagen.flac import FLAC
    from mutagen.mp3 import MP3
    HAS_MUTAGEN = True
except Exception:
    HAS_MUTAGEN = False

SCRIPT_DIR = Path(__file__).parent.resolve()
AXDIO_VERSION = "2.10.1"
SERVER_START_TIME = time.time()
CONFIG_DIR = Path(os.environ.get("CONFIG_DIR") or "/app/config")

# Plugins aren't part of Axdio. An admin installs them from the Plugins page into a Python environment of their
# own in config/plugins/env, which joins the import path here. See PLUGINS.
PLUGINS_DIR = CONFIG_DIR / "plugins"
PLUGIN_ENV = PLUGINS_DIR / "env"
PY_DIR = f"python{sys.version_info[0]}.{sys.version_info[1]}"
def plugin_site_dirs(env=None):
    d = (env or PLUGIN_ENV) / "lib" / PY_DIR / "site-packages"
    return [str(d)] if d.is_dir() else []
def add_plugin_paths():
    import site
    for d in plugin_site_dirs():
        if d not in sys.path: site.addsitedir(d)
add_plugin_paths()
def _vtuple(v):
    return tuple(int(x) for x in re.findall(r"\d+", v or ""))
CONFIG_DIR.mkdir(parents=True, exist_ok=True)
COVERS_CACHE_DIR = CONFIG_DIR / "covers"
COVERS_CACHE_DIR.mkdir(parents=True, exist_ok=True)
LYRICS_CACHE_DIR = CONFIG_DIR / "lyrics"
LYRICS_CACHE_DIR.mkdir(parents=True, exist_ok=True)
AVATAR_DIR = CONFIG_DIR / "avatars"   # profile photos
CARDS_DIR = CONFIG_DIR / "cards"      # link-preview images for shared songs, albums and artists

COOKIES_FILE = CONFIG_DIR / "cookies.txt"
CFG_FILE = CONFIG_DIR / "SpotDL.cfg"
LIBRARY_CACHE_FILE = CONFIG_DIR / "library_cache.json"
USERS_FILE = CONFIG_DIR / "users.json"
SETTINGS_FILE = CONFIG_DIR / "settings.json"
FAVICON_FILE = CONFIG_DIR / "favicon.png"
PWA_ICON_FILE = CONFIG_DIR / "icon-512.png"

app = Flask(__name__, template_folder=str(SCRIPT_DIR / "web"), static_folder=str(SCRIPT_DIR / "web"))
app.secret_key = os.environ.get("SECRET_KEY") or os.environ.get("FLASK_SECRET_KEY") or secrets.token_hex(32)
app.config["MAX_CONTENT_LENGTH"] = 64 * 1024 * 1024   # uploads and backup restores

DEFAULT_SVG_COVER = b"""<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 180 180"><rect width="180" height="180" fill="#242424"/><path fill="#535353" d="M90 60a20 20 0 1 0 0 40 20 20 0 0 0 0-40zm0 50c-26.7 0-40 13.3-40 20v10h80v-10c0-6.7-13.3-20-40-20z"/></svg>"""

users_lock = threading.RLock()
users_data = {}

# Device registry for Connect (see and control playback on other devices)
device_registry_lock = threading.RLock()
active_devices = {}
device_command_queues = {}

def hash_pw(password, salt=None):
    if not salt: salt = secrets.token_hex(16)
    hashed = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 100000).hex()
    return f"{salt}${hashed}"

def verify_pw(password, stored):
    # Stored as "salt$pbkdf2"; legacy plain-text passwords are hashed when accounts load.
    try:
        if not stored or "$" not in stored: return False
        salt, _ = stored.split("$", 1)
        return hmac.compare_digest(hash_pw(password, salt), stored)
    except Exception:
        return False

def admin_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        c = cfg()
        if not c.get("admin_user") or not c.get("admin_password"):
            return redirect(url_for("admin_setup_page"))
        if not session.get("is_admin"):
            return redirect(url_for("admin_login_page"))
        return f(*args, **kwargs)
    return decorated

def load_bat_config():
    cfg = {}
    if CFG_FILE.exists():
        for line in CFG_FILE.read_text(errors="ignore").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or line.startswith(";"): continue
            if "=" in line:
                k, v = line.split("=", 1)
                cfg[k.strip()] = v.strip()
    return cfg

def resolve_dirs(bat_cfg):
    default_base = Path(os.environ.get("CFG_DIR_MUSIC", "/music"))
    return {
        "music_dir": bat_cfg.get("CFG_DIR_MUSIC", str(default_base)),
        "format": "flac",
        "cookies": str(COOKIES_FILE) if COOKIES_FILE.exists() else "",
    }

config = resolve_dirs(load_bat_config())
config["port"] = int(os.environ.get("PORT", 7865))

def get_storage_stats():
    music_path = Path(config["music_dir"])
    music_path.mkdir(parents=True, exist_ok=True)
    total, used, free = shutil.disk_usage(music_path)
    return {
        "total_gb": round(total / (1024 ** 3), 2),
        "used_gb": round(used / (1024 ** 3), 2),
        "free_gb": round(free / (1024 ** 3), 2),
        "used_percent": round((used / total) * 100, 1)
    }

def encode_rel_path(rel_path):
    return base64.urlsafe_b64encode(rel_path.encode()).decode()

def decode_rel_path(token):
    try: return base64.urlsafe_b64decode(token.encode()).decode()
    except Exception: return None

def resolve_safe_music_file(rel_path):
    music_dir = Path(config["music_dir"]).resolve()
    target = (music_dir / rel_path).resolve()
    if not target.is_relative_to(music_dir) or not target.is_file(): return None
    return target

def to_clean_str(val, fallback=""):
    if val is None: return fallback
    if isinstance(val, (list, tuple)):
        return " / ".join(str(v).strip() for v in val if v) if val else fallback
    return str(val).strip() if str(val).strip() else fallback

def sanitize_title_and_extract_num(raw_title, filename=""):
    clean_title = to_clean_str(raw_title, "")
    track_num = None
    clean_title = re.sub(r'(?i)[\(\[](?:official\s*(?:video|audio|music\s*video|visualizer|lyric\s*video|hd|4k)|lyrics?|explicit|remastered|audio|video|prod\.[^\)\]]+)[\)\]]', '', clean_title).strip()
    m = re.match(r'^(\d{1,3})[\s\.\-_:]+(.+)$', clean_title)
    if m:
        try:
            track_num = int(m.group(1))
            clean_title = m.group(2).strip()
        except Exception: pass
    if track_num is None and filename:
        m_fn = re.match(r'^(\d{1,3})[\s\.\-_:]+(.+)$', Path(filename).stem)
        if m_fn:
            try: track_num = int(m_fn.group(1))
            except Exception: pass
    return clean_title if clean_title else to_clean_str(raw_title, "Unknown Track"), track_num

def extract_primary_artist(artist_val, album_artist_val=None):
    alb_art = to_clean_str(album_artist_val)
    if alb_art and alb_art.lower() not in ["various artists", "various", "unknown artist", "unknown"]:
        parts = re.split(r'\s+(?:feat\.?|ft\.?|featuring|with|vs\.?|&)\s+|\s*[/,;]\s*', alb_art, flags=re.IGNORECASE)
        if parts and parts[0].strip(): return parts[0].strip()
        return alb_art
    art = to_clean_str(artist_val, "Unknown Artist")
    if not art or art.lower() in ["unknown artist", "unknown"]: return "Unknown Artist"
    parts = re.split(r'\s+(?:feat\.?|ft\.?|featuring|with|vs\.?|&)\s+|\s*[/,;]\s*', art, flags=re.IGNORECASE)
    if parts and parts[0].strip(): return parts[0].strip()
    return art

library_cache_lock = threading.RLock()
library_cache_data = {}
cached_prebuilt_tree = []
cached_prebuilt_count = 0
library_version = int(time.time())

def rebuild_in_memory_tree():
    global cached_prebuilt_tree, cached_prebuilt_count, library_version
    artists = {}
    # Music other servers share with this one joins the index (see LIBRARY SHARING BETWEEN SERVERS). The first
    # build runs while the module loads, before that section exists; startup builds again once it does.
    shared = fed_library_entries() if "fed_library_entries" in globals() else []
    with library_cache_lock:
        cached_prebuilt_count = len(library_cache_data)
        for rel_path, item in list(library_cache_data.items()) + shared:
            if not isinstance(item, dict): continue
            raw_art = to_clean_str(item.get("artist"), "Unknown Artist")
            alb_art = to_clean_str(item.get("album_artist"), "")
            main_art = extract_primary_artist(raw_art, alb_art)
            alb = to_clean_str(item.get("album"), "Singles")
            clean_title, inferred_num = sanitize_title_and_extract_num(to_clean_str(item.get("title"), Path(rel_path).stem), rel_path)

            artists.setdefault(main_art, {}).setdefault(alb, [])
            track_entry = dict(item)
            track_entry.update({
                "title": clean_title,
                "display_artist": raw_art,
                "artist": main_art,
                "album": alb,
                "track_number": item.get("track_number") or inferred_num,
                "rel_path": rel_path,
                "share_token": item.get("share_token", encode_rel_path(rel_path))
            })
            artists[main_art][alb].append(track_entry)

    tree = []
    for art in sorted(artists.keys(), key=lambda s: str(s).lower()):
        album_list = []
        for alb in sorted(artists[art].keys(), key=lambda s: str(s).lower()):
            sorted_tracks = sorted(
                artists[art][alb],
                key=lambda t: (int(t.get("track_number") or 999), str(t.get("title", "")).lower())
            )
            album_list.append({"name": alb, "tracks": sorted_tracks})
        tree.append({"artist": art, "albums": album_list})
    cached_prebuilt_tree = tree
    library_version = int(time.time() * 1000)

def persist_library_cache():
    with library_cache_lock:
        try:
            temp_file = CONFIG_DIR / "library_cache.tmp"
            with open(temp_file, "w", encoding="utf-8") as f:
                json.dump(library_cache_data, f, indent=2)
                f.flush()
                os.fsync(f.fileno())
            os.replace(temp_file, LIBRARY_CACHE_FILE)
        except Exception as e:
            print(f"[ERROR] Failed to save library_cache.json: {e}")

def save_and_rebuild_cache():
    with library_cache_lock:
        persist_library_cache()
        rebuild_in_memory_tree()

# Song lengths learned while streaming (older entries have none). They're added in place so the
# web apps don't have to resync the whole library for them, and written to disk now and then.
_durations_pending = [0]

def note_duration(rel_path, seconds):
    if not seconds or seconds <= 0: return
    with library_cache_lock:
        e = library_cache_data.get(rel_path)
        if not isinstance(e, dict) or e.get("duration"): return
        e["duration"] = round(seconds, 3)
        _durations_pending[0] += 1
    sid = (_SS.get("by_rel") or {}).get(rel_path)   # the Subsonic view shares the index's song dicts
    if sid: _SS["songs"][sid]["t"]["duration"] = round(seconds, 3)

def flac_duration(path):
    try:
        with open(path, "rb") as f: head = f.read(42)
        if head[:4] != b"fLaC": return None
        si = head[8:42]
        rate = (si[10] << 12) | (si[11] << 4) | (si[12] >> 4)
        total = ((si[13] & 0x0F) << 32) | (si[14] << 24) | (si[15] << 16) | (si[16] << 8) | si[17]
        return total / rate if rate and total else None
    except OSError: return None

def duration_flusher():
    while True:
        time.sleep(600)
        if _durations_pending[0]:
            _durations_pending[0] = 0
            persist_library_cache()

AUDIO_TYPES = {".flac": "audio/flac", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac",
               ".ogg": "audio/ogg", ".opus": "audio/ogg", ".wav": "audio/wav"}

def _save_cover(rel_path, data):
    if not data: return False
    cov = COVERS_CACHE_DIR / f"{hashlib.md5(rel_path.encode()).hexdigest()}.jpg"
    if not cov.exists():
        try: cov.write_bytes(bytes(data))
        except OSError: pass
    return True

def _first(tags, *keys):
    for k in keys:
        try: v = tags.get(k)
        except Exception: v = None
        if v:
            v = v[0] if isinstance(v, list) else v
            if isinstance(v, tuple): v = v[0]
            return str(v)
    return None

def extract_tags_for_file(file_path, rel_path):
    title, artist, album, album_artist, track_num, has_cover, duration = file_path.stem, "Unknown Artist", "Singles", "", None, False, None
    unread = False
    if HAS_MUTAGEN:
        try:
            ext = file_path.suffix.lower()
            if ext == ".flac":
                audio = FLAC(str(file_path))
                title = _first(audio, "title") or title
                artist = _first(audio, "artist") or artist
                album = _first(audio, "album") or album
                album_artist = _first(audio, "albumartist", "album artist") or ""
                track_num = _first(audio, "tracknumber")
                if audio.pictures: has_cover = _save_cover(rel_path, audio.pictures[0].data)
            elif ext == ".mp3":
                audio = MP3(str(file_path))
                tags = audio.tags or {}
                title = _first(tags, "TIT2") or title
                artist = _first(tags, "TPE1") or artist
                album = _first(tags, "TALB") or album
                album_artist = _first(tags, "TPE2") or ""
                track_num = _first(tags, "TRCK")
                for k in list(tags.keys()):
                    if k.startswith("APIC:"):
                        has_cover = _save_cover(rel_path, tags[k].data); break
            else:
                import mutagen
                audio = mutagen.File(str(file_path))
                tags = (audio.tags if audio is not None else None) or {}
                title = _first(tags, "\xa9nam", "title", "TIT2") or title
                artist = _first(tags, "\xa9ART", "artist", "TPE1") or artist
                album = _first(tags, "\xa9alb", "album", "TALB") or album
                album_artist = _first(tags, "aART", "albumartist", "TPE2") or ""
                trk = tags.get("trkn") if hasattr(tags, "get") else None
                track_num = str(trk[0][0]) if trk else _first(tags, "tracknumber", "TRCK")
                covr = tags.get("covr") if hasattr(tags, "get") else None
                if covr: has_cover = _save_cover(rel_path, covr[0])
                elif hasattr(tags, "get") and tags.get("metadata_block_picture"):
                    from mutagen.flac import Picture
                    has_cover = _save_cover(rel_path, Picture(base64.b64decode(tags["metadata_block_picture"][0])).data)
            duration = round(float(audio.info.length), 3) if audio is not None and getattr(audio, "info", None) else None
        except Exception:
            unread = True           # e.g. a network mount that didn't answer in time: tried again on the next scan

    clean_t, inf_num = sanitize_title_and_extract_num(title, rel_path)
    entry = {
        "title": clean_t,
        "artist": artist,
        "album": album,
        "track_number": track_num or inf_num,
        "has_cover": has_cover,
        "mtime": file_path.stat().st_mtime
    }
    if album_artist: entry["album_artist"] = album_artist
    if duration: entry["duration"] = duration
    if unread: entry["unread"] = True
    return entry

# Before 2.9 a read that failed was cached as the file's tags (its name as the title, "Singles" as the album) until the
# file changed. The first scan after updating reads those songs again, once.
REREAD_MARK = CONFIG_DIR / "library_reread_v1"

def _looks_unread(entry, rel):
    return entry.get("has_cover") is None and entry.get("album") == "Singles" and entry.get("title") == Path(rel).stem

SCAN = {"running": False, "last": 0, "took": 0, "files": 0, "added": 0, "updated": 0, "removed": 0, "error": ""}
_scan_now = threading.Event()

def scan_library():
    music_dir = Path(config["music_dir"]).resolve()
    if not music_dir.is_dir():
        SCAN["error"] = f"Music folder not found: {music_dir}"
        return
    t0 = time.time()
    SCAN.update(running=True, error="")
    current, added, updated = set(), 0, 0
    reread = not REREAD_MARK.exists()
    try:
        for root, dirs, files in os.walk(music_dir):
            dirs[:] = [d for d in dirs if not d.startswith((".", "@"))]
            for name in files:
                if name.startswith(".") or os.path.splitext(name)[1].lower() not in AUDIO_TYPES: continue
                p = Path(root) / name
                rel = str(p.relative_to(music_dir))
                current.add(rel)
                try: mtime = p.stat().st_mtime
                except OSError: continue
                with library_cache_lock: existing = library_cache_data.get(rel)
                if existing and existing.get("mtime") == mtime and not existing.get("unread") and not (reread and _looks_unread(existing, rel)): continue
                entry = extract_tags_for_file(p, rel)   # slow file IO stays outside the lock
                with library_cache_lock: library_cache_data[rel] = entry
                if existing: updated += 1
                else: added += 1
        with library_cache_lock:
            gone = [r for r in library_cache_data if r not in current]
            # A remote mount that drops out looks like an empty folder; don't wipe the library for it.
            if len(gone) > 50 and len(gone) > 0.5 * len(library_cache_data):
                SCAN["error"] = f"Skipped removing {len(gone)} songs: most of the library vanished at once (is the music folder mounted?)"
                gone = []
            for r in gone: del library_cache_data[r]
        if added or updated or gone: save_and_rebuild_cache()
        if reread: REREAD_MARK.touch()
        SCAN.update(files=len(current), added=added, updated=updated, removed=len(gone))
    except Exception as ex:
        SCAN["error"] = str(ex)
    finally:
        SCAN.update(running=False, last=time.time(), took=round(time.time() - t0, 1))

def library_scanner():
    time.sleep(3)
    while True:
        scan_library()
        if not DUP_REPAIR_MARK.exists() and not SCAN["error"]:
            try: repair_duplicate_homes()
            except Exception as ex: print(f"[WARN] Checking where duplicates were kept failed: {ex}")
        minutes = int(cfg().get("scan_interval") or 0)
        _scan_now.wait(timeout=minutes * 60 if minutes > 0 else None)
        _scan_now.clear()

def backfill_durations():
    """Song lengths for older library entries, taken from library audit results (no file reads)."""
    try:
        with open(CONFIG_DIR / "library_audit.json", "r", encoding="utf-8") as f: audit = json.load(f)
    except Exception: return 0
    n = 0
    with library_cache_lock:
        for rel, e in library_cache_data.items():
            a = audit.get(rel)
            if isinstance(e, dict) and not e.get("duration") and isinstance(a, dict) and a.get("duration") and a.get("mtime") == e.get("mtime"):
                e["duration"] = a["duration"]; n += 1
    if n: save_and_rebuild_cache()
    return n

def load_persistent_cache():
    global library_cache_data
    if LIBRARY_CACHE_FILE.exists():
        try:
            with open(LIBRARY_CACHE_FILE, "r", encoding="utf-8") as f:
                library_cache_data = json.load(f)
        except Exception:
            library_cache_data = {}
    rebuild_in_memory_tree()

load_persistent_cache()

@app.before_request
def force_ssl_middleware():
    if cfg().get("force_ssl", False) and request.path != "/api/health":
        proto = request.headers.get("X-Forwarded-Proto", request.scheme)
        if proto != "https" and not request.is_secure:
            return redirect(request.url.replace("http://", "https://", 1), code=301)

# Every /api/admin/* route is admin-only. Enforced here rather than per route so
# routes spliced in later (see the AXDIO admin controller below) can't skip it.
@app.before_request
def require_admin_for_admin_api():
    if request.path.startswith("/api/admin/") and not session.get("is_admin"):
        return jsonify({"error": "Admin authentication required"}), 401

@app.route("/")
@app.route("/offline")
@app.route("/history")
@app.route("/artists")
@app.route("/albums")
@app.route("/liked")
@app.route("/playlist")
@app.route("/profile")
@app.route("/settings")
@app.route("/messages")
@app.route("/friends")
@app.route("/user")
def spa_router():
    nxt = request.args.get("next", "")
    if nxt and _SHARE_OPEN.fullmatch(nxt) and get_current_user(): return redirect(nxt)
    return render_template(get_app_template(), settings=cfg())

@app.route("/manifest.json")
def manifest_json():
    return jsonify({
        "name": cfg().get("site_title", "Axdio"),
        "short_name": cfg().get("site_title", "Axdio"),
        "description": cfg().get("site_tagline", ""),
        "start_url": "/",
        "display": "standalone",
        "background_color": "#000000",
        "theme_color": "#000000",
        "icons": [{"src": "/api/app-icon", "sizes": "512x512", "type": "image/png", "purpose": "any maskable"}]
    })

@app.route("/favicon.ico")
def custom_favicon():
    if FAVICON_FILE.exists():
        return send_file(FAVICON_FILE, mimetype=_sniff_image(FAVICON_FILE.read_bytes()[:64])[1] or "image/png", max_age=3600)
    return Response(DEFAULT_SVG_COVER, mimetype="image/svg+xml")

@app.route("/api/app-icon")
def custom_pwa_icon():
    if PWA_ICON_FILE.exists(): return send_file(PWA_ICON_FILE, mimetype="image/png")
    if FAVICON_FILE.exists(): return send_file(FAVICON_FILE, mimetype="image/png")
    return Response(DEFAULT_SVG_COVER, mimetype="image/svg+xml")

@app.route("/api/library/version")
def api_library_version():
    with library_cache_lock:
        return jsonify({"version": library_version, "count": cached_prebuilt_count})

@app.route("/api/library/cache")
def api_library_cache():
    with library_cache_lock:
        return jsonify({
            "library": cached_prebuilt_tree,
            "cached_count": cached_prebuilt_count,
            "version": library_version,
            "storage": get_storage_stats(),
            "settings": get_public_settings()
        })

@app.route("/api/cover")
def api_cover():
    token = request.args.get("token")
    rel_path = decode_rel_path(token) if token else request.args.get("path")
    return cover_response(rel_path)

def cover_file_for(rel_path):
    """The cached cover image for a song: its own embedded art, else another song's from the same album or artist."""
    if not rel_path: return None
    cover_file = COVERS_CACHE_DIR / f"{hashlib.md5(rel_path.encode()).hexdigest()}.jpg"
    if cover_file.exists(): return cover_file
    with library_cache_lock:
        item = library_cache_data.get(rel_path)
        if item:
            target_album = to_clean_str(item.get("album"), "").lower()
            target_artist = to_clean_str(item.get("artist"), "").lower()
            for r, other in library_cache_data.items():
                if other.get("has_cover") and (
                        (target_album and to_clean_str(other.get("album"), "").lower() == target_album) or
                        (target_artist and to_clean_str(other.get("artist"), "").lower() == target_artist)):
                    other_cov = COVERS_CACHE_DIR / f"{hashlib.md5(r.encode()).hexdigest()}.jpg"
                    if other_cov.exists(): return other_cov
    return None

def cover_response(rel_path):
    """Cover art for a song (see cover_file_for), or a placeholder."""
    if FED_REMOTE_RE.match(rel_path or ""): return remote_cover(rel_path)
    cover_file = cover_file_for(rel_path)
    if cover_file: return send_file(cover_file, mimetype="image/jpeg", max_age=2592000)
    return Response(DEFAULT_SVG_COVER, mimetype="image/svg+xml")

# Open Synced & Plain Lyrics Provider
@app.route("/api/lyrics")
def api_lyrics():
    return (lyrics_for(request.args.get("artist", "").strip(), request.args.get("title", "").strip(), request.args.get("album", "").strip()))

def lyrics_for(artist, title, album=""):
    """{"synced": LRC text or None, "plain": text or None}, cached in config/lyrics."""
    if not artist or not title:
        return {"synced": None, "plain": None}

    hash_id = hashlib.md5(f"{artist}_{title}".lower().encode()).hexdigest()
    lyrics_file = LYRICS_CACHE_DIR / f"{hash_id}.json"
    if lyrics_file.exists():
        try:
            with open(lyrics_file, "r", encoding="utf-8") as f:
                data = json.load(f)
                if data.get("synced"): return data
        except Exception: pass

    clean_title = re.sub(r'(?i)\s*[\(\[](?:feat|ft|with|prod\.|remastered|deluxe|explicit|version).*?[\)\]]', '', title).strip()
    clean_artist = re.split(r'(?i)\s*(?:feat\.?|ft\.?|&|,|\/)\s*', artist)[0].strip()

    try:
        q_dict = {"artist_name": clean_artist, "track_name": clean_title}
        if album and album.lower() not in ["singles", "single", "unknown", ""]:
            q_dict["album_name"] = album
        url = f"https://lrclib.net/api/get?{urllib.parse.urlencode(q_dict)}"
        req = urllib.request.Request(url, headers={"User-Agent": f"Axdio/{AXDIO_VERSION}"})
        with urllib.request.urlopen(req, timeout=4) as resp:
            data = json.loads(resp.read().decode())
            if data.get("syncedLyrics"):
                payload = {"synced": data.get("syncedLyrics"), "plain": data.get("plainLyrics")}
                with open(lyrics_file, "w", encoding="utf-8") as f: json.dump(payload, f)
                return payload
    except Exception: pass

    try:
        q_search = urllib.parse.urlencode({"q": f"{clean_artist} {clean_title}"})
        url_search = f"https://lrclib.net/api/search?{q_search}"
        req_s = urllib.request.Request(url_search, headers={"User-Agent": f"Axdio/{AXDIO_VERSION}"})
        with urllib.request.urlopen(req_s, timeout=4) as resp_s:
            items = json.loads(resp_s.read().decode())
            if items and isinstance(items, list):
                synced_item = next((it for it in items if it.get("syncedLyrics")), None)
                if synced_item:
                    payload = {"synced": synced_item.get("syncedLyrics"), "plain": synced_item.get("plainLyrics")}
                    with open(lyrics_file, "w", encoding="utf-8") as f: json.dump(payload, f)
                    return payload
                plain_item = next((it for it in items if it.get("plainLyrics")), items[0])
                payload = {"synced": plain_item.get("syncedLyrics"), "plain": plain_item.get("plainLyrics")}
                with open(lyrics_file, "w", encoding="utf-8") as f: json.dump(payload, f)
                return payload
    except Exception: pass

    return {"synced": None, "plain": None}

@app.route("/api/stream_path")
def stream_by_path():
    token = request.args.get("token")
    rel_path = decode_rel_path(token) if token else request.args.get("path")
    if not rel_path: abort(404)
    if FED_REMOTE_RE.match(rel_path): return remote_stream(rel_path, QUALITY_KBPS.get(request.args.get("q", "")))
    file_path = resolve_safe_music_file(rel_path)
    if not file_path or not file_path.exists():
        if library_entry(rel_path) is not None and not (Path(get_real_music_dir()) / rel_path).exists():
            threading.Thread(target=forget_library_paths, args=([rel_path],), daemon=True).start()   # deleted outside Axdio
        abort(404)
    return stream_file_response(file_path, rel_path, QUALITY_KBPS.get(request.args.get("q", "")))

def stream_file_response(file_path, rel_path, kbps=None):
    """The audio for one song: a data saver MP3 when `kbps` is set and possible, else the file (with Range support)."""
    if kbps and cfg().get("feature_transcoding", True) and file_path.suffix.lower() != ".mp3":
        resp = serve_transcoded(file_path, rel_path, kbps)
        if resp is not None: return resp

    if file_path.suffix.lower() == ".flac" and request.headers.get("Range", "bytes=0-").startswith("bytes=0-"):
        note_duration(rel_path, flac_duration(file_path))
    mime = AUDIO_TYPES.get(file_path.suffix.lower(), "application/octet-stream")
    file_size = file_path.stat().st_size
    range_header = request.headers.get('Range', None)

    if not range_header:
        res = send_file(str(file_path), mimetype=mime, as_attachment=False, conditional=True)
        res.headers['Accept-Ranges'] = 'bytes'
        res.headers['Content-Length'] = str(file_size)
        return res

    byte1, byte2 = 0, None
    m = re.search(r'bytes=(\d+)-(\d*)', range_header)
    if m:
        g = m.groups()
        byte1 = int(g[0])
        if g[1]: byte2 = int(g[1])

    if byte2 is None: byte2 = file_size - 1
    length = byte2 - byte1 + 1

    def generate_chunks():
        with open(file_path, 'rb') as f:
            f.seek(byte1)
            remaining = length
            chunk_size = 64 * 1024
            while remaining > 0:
                data = f.read(min(remaining, chunk_size))
                if not data: break
                remaining -= len(data)
                yield data

    resp = Response(generate_chunks(), 206, mimetype=mime, direct_passthrough=True)
    resp.headers.add('Content-Range', f'bytes {byte1}-{byte2}/{file_size}')
    resp.headers.add('Accept-Ranges', 'bytes')
    resp.headers.add('Content-Length', str(length))
    return resp

# Device Registry & Connect System
@app.route("/api/devices/heartbeat", methods=["POST"])
def api_devices_heartbeat():
    user = connect_owner()
    data = request.json or {}
    device_id = data.get("device_id")
    device_name = data.get("device_name", "Web Player")
    state = data.get("state", {})

    if not device_id:
        return jsonify({"error": "Missing device_id"}), 400

    now = time.time()
    with device_registry_lock:
        active_devices.setdefault(user, {})[device_id] = {
            "id": device_id,
            "name": device_name,
            "last_seen": now,
            "state": state
        }
        pending_cmd = device_command_queues.get(device_id)
        if pending_cmd:
            del device_command_queues[device_id]

    if not user.startswith("guest@") and isinstance(state, dict):
        note_presence(user, state.get("rel_path"), state.get("playing"), state.get("currentTime"))
        return jsonify({"success": True, "command": pending_cmd, "sv": social_version(user)})
    return jsonify({"success": True, "command": pending_cmd})

@app.route("/api/devices/list", methods=["GET"])
def api_devices_list():
    user = connect_owner()
    now = time.time()
    devices_out = []

    with device_registry_lock:
        user_devs = active_devices.get(user, {})
        for d_id, d in list(user_devs.items()):
            if now - d["last_seen"] <= 12:
                devices_out.append({
                    "id": d["id"],
                    "name": d["name"],
                    "is_active": (now - d["last_seen"] <= 6),
                    "state": d.get("state", {})
                })
            else:
                del user_devs[d_id]

    return jsonify({"devices": devices_out})

@app.route("/api/devices/transfer", methods=["POST"])
def api_devices_transfer():
    user = connect_owner()
    data = request.json or {}
    target_id = data.get("target_device_id")
    playback = data.get("playback", {})

    if not target_id:
        return jsonify({"error": "Missing target_device_id"}), 400

    with device_registry_lock:
        user_devs = active_devices.get(user, {})
        target = user_devs.get(target_id)
        if not target or (time.time() - target["last_seen"] > 12):
            return jsonify({"success": False, "error": "Device is unreachable"}), 404

        device_command_queues[target_id] = {
            "type": "transfer_playback",
            "playback": playback,
            "timestamp": time.time()
        }

    return jsonify({"success": True})

# User Auth & Profile Settings Endpoints
@app.route("/api/user/sync", methods=["GET", "POST"])
def user_sync_data():
    username = get_current_user()
    if not username:
        return jsonify({"authenticated": False, "liked_songs": [], "playlists": {}, "offline_tracks": [], "history": []})
    with users_lock:
        u = users_data.get(username, {})
        if request.method == "POST":
            data = request.json or {}
            for k in ["liked_songs", "playlists", "offline_tracks"]:
                if k in data: u[k] = data[k]
            save_users(username)
            return jsonify({"success": True})
        return jsonify({
            "authenticated": True, "username": username,
            "display_name": u.get("display_name", username.capitalize()),
            "avatar": u.get("avatar", ""),
            "preferences": u.get("preferences", {}),
            "liked_songs": u.get("liked_songs", []), "playlists": u.get("playlists", {}),
            "offline_tracks": u.get("offline_tracks", []), "history": u.get("history", []),
            "discord": {k: (u.get("discord") or {}).get(k, "") for k in ("username", "name")} if u.get("discord") else None,
            "password_login": u.get("password_login", True) is not False, "presence": bool(u.get("presence")),
        })

@app.route("/api/user/profile", methods=["GET", "POST"])
def user_profile_endpoint():
    username = get_current_user()
    if not username:
        return jsonify({"error": "Authentication required"}), 401

    with users_lock:
        u = users_data.get(username, {})
        if request.method == "POST":
            data = request.json or {}
            if "display_name" in data:
                u["display_name"] = str(data["display_name"]).strip()[:32]
            if "avatar" in data:
                av = str(data["avatar"] or "").strip()
                if av != u.get("avatar", ""):
                    if av and not re.match(r"https?://", av, re.I):
                        return jsonify({"error": "Upload a photo instead, or use an http(s) image link."}), 400
                    drop_avatar_file(u)
                    u["avatar"] = av[:500]
            if "preferences" in data and isinstance(data["preferences"], dict):
                u.setdefault("preferences", {}).update(data["preferences"])
            save_users(username)
            return jsonify({"success": True, "display_name": u.get("display_name"), "preferences": u.get("preferences")})

        # Calculate top artists & listening metrics from user play history
        history = u.get("history", [])
        artist_counts = Counter()
        total_plays = sum(h.get("count", 1) for h in history)
        
        with library_cache_lock:
            for item in history:
                rp = item.get("rel_path")
                meta = library_cache_data.get(rp)
                if meta and meta.get("artist"):
                    artist_counts[meta["artist"]] += item.get("count", 1)

        top_artists = [art for art, _ in artist_counts.most_common(5)]

        return jsonify({
            "username": username,
            "display_name": u.get("display_name", username.capitalize()),
            "avatar": u.get("avatar", ""),
            "created": u.get("created", "2026-01-01"),
            "liked_count": len(u.get("liked_songs", [])),
            "playlist_count": len(u.get("playlists", {})),
            "total_plays": total_plays,
            "top_artists": top_artists,
            "preferences": u.get("preferences", {})
        })

# Profile photos: re-encoded by ffmpeg to a 512 px square JPEG (which also drops camera and location data)
# and stored in config/avatars under a random name, so each upload gets a new URL that can be cached forever.
AVATAR_MAX_BYTES = 10 * 1024 * 1024
_AVATAR_DEMUXERS = {"jpeg": "jpeg_pipe", "png": "png_pipe", "webp": "webp_pipe", "gif": "gif"}
_AVATAR_URL = re.compile(r"/api/avatar/([0-9a-f]{20})\.jpg")

def _avatar_kind(data):
    if data[:3] == b"\xff\xd8\xff": return "jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n": return "png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP": return "webp"
    if data[:6] in (b"GIF87a", b"GIF89a"): return "gif"
    return None

def avatar_file(url):
    m = _AVATAR_URL.fullmatch(url or "")
    return AVATAR_DIR / f"{m.group(1)}.jpg" if m else None

def drop_avatar_file(rec):
    """Delete a user's uploaded photo from disk (the record keeps its avatar field; callers reset it)."""
    f = avatar_file(rec.get("avatar"))
    if f: f.unlink(missing_ok=True)

def save_avatar(data):
    """Store an uploaded image as a profile photo. Returns its URL, or raises ValueError with a message for the user."""
    kind = _avatar_kind(data)
    if not kind: raise ValueError("Use a JPEG, PNG, WebP or GIF image.")
    AVATAR_DIR.mkdir(parents=True, exist_ok=True)
    name = secrets.token_hex(10)
    src, out = AVATAR_DIR / f".{name}.upload", AVATAR_DIR / f"{name}.jpg"
    try:
        src.write_bytes(data)
        # The demuxer is fixed to the sniffed image type so ffmpeg never treats the upload as a playlist or other format.
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-protocol_whitelist", "file", "-f", _AVATAR_DEMUXERS[kind], "-i", str(src),
                        "-filter_complex", "color=c=0x282828:s=512x512[bg];[0:v]crop='min(iw,ih)':'min(iw,ih)',scale=512:512:flags=lanczos[fg];"
                        "[bg][fg]overlay=format=auto:shortest=1,format=yuvj420p",
                        "-frames:v", "1", "-q:v", "3", str(out)], check=True, capture_output=True, timeout=30)
        if not out.exists() or out.stat().st_size < 100: raise ValueError
    except Exception:
        out.unlink(missing_ok=True)
        raise ValueError("That image couldn't be read. Try a JPEG or PNG.")
    finally:
        src.unlink(missing_ok=True)
    return f"/api/avatar/{name}.jpg"

@app.route("/api/user/avatar", methods=["POST", "DELETE"])
def user_avatar():
    username = _me()
    if request.method == "DELETE":
        with users_lock:
            rec = users_data[username]
            drop_avatar_file(rec)
            rec["avatar"] = ""
            save_users(username)
        return jsonify({"ok": True, "avatar": ""})
    if not cfg().get("feature_avatars", True): return jsonify({"error": "Profile photos are turned off on this server."}), 403
    f = request.files.get("file")
    data = f.read(AVATAR_MAX_BYTES + 1) if f else request.get_data(cache=False)
    if not data: return jsonify({"error": "No image received."}), 400
    if len(data) > AVATAR_MAX_BYTES: return jsonify({"error": "That image is over 10 MB."}), 413
    try: url = save_avatar(data)
    except ValueError as ex: return jsonify({"error": str(ex)}), 400
    with users_lock:
        rec = users_data.get(username)
        if rec is None:
            avatar_file(url).unlink(missing_ok=True)
            return jsonify({"error": "Sign in first."}), 401
        drop_avatar_file(rec)
        rec["avatar"] = url
        save_users(username)
    return jsonify({"ok": True, "avatar": url})

@app.route("/api/avatar/<name>")
def serve_avatar(name):
    f = avatar_file("/api/avatar/" + name)
    if not f or not f.exists(): abort(404)
    resp = send_file(f, mimetype="image/jpeg", max_age=31536000)
    resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return resp

@app.route("/api/user/change_password", methods=["POST"])
def user_change_password():
    username = get_current_user()
    if not username:
        return jsonify({"error": "Authentication required"}), 401

    data = request.json or {}
    old_pw = data.get("old_password") or ""
    new_pw = data.get("new_password") or ""

    err = _check_password(new_pw)
    if err: return jsonify({"error": err}), 400

    with users_lock:
        u = users_data.get(username, {})
        if u.get("password_login") is not False and not verify_pw(old_pw, u.get("password", "")):
            return jsonify({"error": "Current password is incorrect"}), 400

        u["password"] = hash_pw(new_pw)
        u["password_login"] = True
        save_users(username)

    return jsonify({"success": True, "message": "Password updated successfully"})

@app.route("/api/user/record_play", methods=["POST"])
def user_record_play():
    username = get_current_user()
    if not username: return jsonify({"success": False})
    rel_path = (request.json or {}).get("rel_path")
    if not rel_path: return jsonify({"error": "No track specified"}), 400
    record_play_for(username, rel_path)
    return jsonify({"success": True})

def record_play_for(username, rel_path):
    with users_lock:
        u = users_data.get(username, {})
        history = u.setdefault("history", [])
        for item in history:
            if item.get("rel_path") == rel_path:
                item["count"] = item.get("count", 1) + 1
                item["last_played"] = datetime.now().isoformat()
                break
        else:
            history.insert(0, {"rel_path": rel_path, "count": 1, "last_played": datetime.now().isoformat()})
            u["history"] = history[:1000]
        save_users(username)
    log_play(username, rel_path)

@app.route("/admin/setup", methods=["GET", "POST"])
def admin_setup_page():
    c = cfg()
    if c.get("admin_user") and c.get("admin_password"):
        return redirect(url_for("admin_login_page"))
    error = None
    if request.method == "POST":
        u, p, p_c = request.form.get("username", "").strip(), request.form.get("password", ""), request.form.get("confirm_password", "")
        if not u: error = "Choose an admin username."
        elif len(p) < 8: error = "Use at least 8 characters for the admin password."
        elif p != p_c: error = "The passwords don't match."
        else:
            cfg_save({"admin_user": u, "admin_password": hash_pw(p)})
            session["is_admin"] = True
            session["admin_user"] = u
            session.permanent = True
            activity("admin_setup", "Created the admin account", u)
            return redirect(url_for("admin_dashboard"))
    return render_template("admin_login.html", settings=c, error=error, is_setup=True)

@app.route('/mobile')
@app.route('/mobile.html')
def serve_mobile_page():
    import os
    from flask import send_from_directory, make_response
    base_dir = os.path.dirname(os.path.abspath(__file__))
    resp = make_response(send_from_directory(os.path.join(base_dir, 'web'), 'mobile.html'))
    resp.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    resp.headers['Pragma'] = 'no-cache'
    resp.headers['Expires'] = '0'
    return resp

# ============================================================
# AXDIO COMPREHENSIVE ADMIN CONTROLLER
# ============================================================
import subprocess, threading, collections, urllib.request, urllib.parse
import json, shutil, os, glob, re, time, signal, hashlib, traceback
from pathlib import Path

def get_real_music_dir():
    return str(Path(config["music_dir"]).resolve())


admin_scrape_state = {"status": "idle", "logs": collections.deque(maxlen=400), "scraped": 0, "total": 0, "scanned": 0}
scrape_lock = threading.Lock()

admin_lyrics_state = {"status": "idle", "logs": collections.deque(maxlen=400), "fetched": 0, "total": 0, "scanned": 0}
lyrics_lock = threading.Lock()

def clean_filename(text, fallback="Unknown"):
    if not text: return fallback
    s = re.sub(r'[\\/*?:"<>|]', "", str(text).strip()).strip(". ")
    return s if s else fallback

# ============================================================
# AUDIO IDENTITY VERIFICATION
# Catalog metadata is only ever attached to audio whose Chromaprint fingerprint
# matches that song's catalog preview (Deezer / iTunes 30 s clips). Measured on
# this library: same recording ~0.05 bit-error rate, different songs 0.42-0.48.
# ============================================================
import struct, tempfile, unicodedata, uuid
try:
    from rapidfuzz import fuzz as _fuzz
    def _ratio(a, b): return _fuzz.ratio(a, b)
except Exception:
    import difflib
    def _ratio(a, b): return difflib.SequenceMatcher(None, a, b).ratio() * 100

FP_MATCH_BER = 0.20
FP_MISMATCH_BER = 0.33
FP_ITEM_SEC = 1365 / 11025        # Chromaprint frame hop
FP_WINDOW_SEC = 150               # catalog previews normally sit in the first two minutes
WORK_DIR = Path(tempfile.gettempdir()) / "axdio_work"
QUARANTINE_DIR = CONFIG_DIR / "quarantine"
QUARANTINE_INDEX = QUARANTINE_DIR / "index.json"
AUDIT_DB_FILE = CONFIG_DIR / "library_audit.json"
shutil.rmtree(WORK_DIR, ignore_errors=True)


class YouTubeBlocked(Exception):
    """YouTube demanded bot verification; retrying immediately only makes it worse."""


def _work_path(suffix):
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    return WORK_DIR / f"{uuid.uuid4().hex}{suffix}"


def _load_json_file(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f: return json.load(f)
    except Exception: return default


def _save_json_file(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


# --- HTTP (per-host throttled: Deezer allows 50 req / 5 s, iTunes ~20 req / min) ---
_http_lock = threading.Lock()
_http_next = {}
_http_blocked_until = {}

def http_json(url, host_gap=0.15, timeout=15, retries=3):
    host = urllib.parse.urlparse(url).netloc
    if _http_blocked_until.get(host, 0) > time.time(): return None
    for attempt in range(retries):
        with _http_lock:
            now = time.time()
            slot = max(now, _http_next.get(host, 0))
            _http_next[host] = slot + host_gap
        if slot > now: time.sleep(slot - now)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Axdio Music Server)"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = json.loads(r.read().decode("utf-8"))
            err = data.get("error") if isinstance(data, dict) else None
            if isinstance(err, dict) and err.get("code") == 4:   # Deezer quota exceeded
                time.sleep(5)
                continue
            return data
        except urllib.error.HTTPError as e:
            if e.code in (403, 429) and "itunes" in host:
                _http_blocked_until[host] = time.time() + 90   # iTunes rate limit: back off instead of queueing
                return None
            if e.code in (403, 429, 500, 502, 503): time.sleep(3 * (attempt + 1)); continue
            return None
        except Exception:
            time.sleep(1 + attempt)
    return None


def fetch_bytes(url, timeout=20, limit=15 * 1024 * 1024):
    if not url: return None
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=timeout) as r: return r.read(limit)
    except Exception: return None


# --- Fingerprints ---
def audio_fingerprint(path, max_seconds=None):
    cmd = ["ffmpeg", "-v", "error", "-nostdin"]
    if max_seconds: cmd += ["-t", str(max_seconds)]
    cmd += ["-i", str(path), "-vn", "-ac", "1", "-f", "chromaprint", "-fp_format", "raw", "-"]
    try: out = subprocess.run(cmd, capture_output=True, timeout=900).stdout
    except Exception: return []
    n = len(out) // 4
    return list(struct.unpack("<%dI" % n, out[:n * 4])) if n else []


def fingerprint_similarity(ref, sample):
    """Best alignment of a catalog preview inside a track: (bit_error_rate, offset_seconds)."""
    n, m = len(ref), len(sample)
    if n < 40 or m < 40: return 1.0, 0.0
    min_overlap = max(40, int(min(n, m) * 0.6))
    best_ber, best_off = 1.0, 0
    for off in range(min_overlap - n, m - min_overlap + 1):
        lo, hi = max(0, -off), min(n, m - off)
        errs = cnt = 0
        for i in range(lo, hi, 4):        # coarse pass on every 4th frame
            errs += (ref[i] ^ sample[i + off]).bit_count()
            cnt += 1
        ber = errs / (cnt * 32.0)
        if ber < best_ber: best_ber, best_off = ber, off
    lo, hi = max(0, -best_off), min(n, m - best_off)
    errs = sum((ref[i] ^ sample[i + best_off]).bit_count() for i in range(lo, hi))
    return errs / ((hi - lo) * 32.0), best_off * FP_ITEM_SEC


# --- Title / artist matching ---
_VERSION_MARKERS = [
    ("live", r"\blive\b"),
    ("remix", r"\b(?:re-?mix|rmx|rework|bootleg|flip|vip|mashup|dub)\b|(?<!original )(?<!radio )(?<!album )\bmix\b"),
    ("acoustic", r"\bacoustic\b|\bunplugged\b"),
    ("instrumental", r"\binstrumental\b"),
    ("acapella", r"\ba\s*cap+el+a\b|\bacap+el+a\b"),
    ("karaoke", r"\bkaraoke\b"),
    ("sped", r"\bsped\s*up\b|\bnightcore\b"),
    ("slowed", r"\bslowed\b|\breverb\b"),
    ("extended", r"\bextended\b"),
    ("radio", r"\bradio\s+(?:edit|version|mix)\b"),
    ("demo", r"\bdemo\b"),
    ("cover", r"\bcover\b"),
    ("mixed", r"\bmixed\b"),
    ("8d", r"\b8d\b"),
    ("orchestral", r"\borchestral\b|\bpiano version\b|\bstrings? version\b"),
]
_FEAT_RE = re.compile(r"(?i)[\(\[]\s*(?:feat\.?|ft\.?|featuring|with)\s[^\)\]]*[\)\]]|\s-\s*(?:feat\.?|ft\.?|featuring|with)\s.*$|\s(?:feat\.?|ft\.?|featuring)\s.*$")
_FROM_RE = re.compile(r"(?i)[\(\[]\s*from\s[^\)\]]*[\)\]]|\s-\s*from\s.*$")
_NOISE_RE = re.compile(r"(?i)\b(?:(?:\d{4}\s+)?(?:digital(?:ly)?\s+)?remaster(?:ed)?(?:\s+\d{4})?(?:\s+version)?|explicit(?:\s+version)?|clean(?:\s+version)?|album version|single version|original (?:mix|version)|mono|stereo|bonus track|deluxe(?:\s+(?:edition|version))?)\b")


def _norm(s):
    s = unicodedata.normalize("NFKD", str(s or "").lower())
    s = "".join(c for c in s if not unicodedata.combining(c)).replace("&", "and")
    return re.sub(r"[\W_]+", "", s)


def version_markers(text):
    t = str(text or "").lower()
    return frozenset(name for name, pat in _VERSION_MARKERS if re.search(pat, t))


def title_key(title):
    t = _NOISE_RE.sub(" ", _FROM_RE.sub(" ", _FEAT_RE.sub(" ", str(title or ""))))
    return _norm(t), version_markers(title)


def title_match(label_title, other_title, allow_version_diff=False):
    """(matches, exact). Bracketed text stays significant: 'Pt. 1' is not 'Pt. 7'."""
    (a, am), (b, bm) = title_key(label_title), title_key(other_title)
    if not a or not b: return False, False
    if a == b: return True, True
    if not allow_version_diff and am != bm: return False, False
    if re.findall(r"\d+", a) != re.findall(r"\d+", b): return False, False
    return (min(len(a), len(b)) >= 5 and _ratio(a, b) >= 92), False


def artist_keys(artists):
    if isinstance(artists, str): artists = [artists]
    out = set()
    for a in artists or []:
        a = str(a or "").strip()
        if not a or a.lower() in ("various artists", "unknown artist", "unknown"): continue
        out.add(_norm(a))
        for piece in re.split(r"(?i)\s*(?:,|;|/|\bfeat\.?|\bft\.?|\bfeaturing\b|\sx\s|\s&\s|\swith\s)\s*", a):
            if _norm(piece): out.add(_norm(piece))
    out.discard("")
    return out


def artist_match(label_keys, other_artist):
    other = artist_keys(other_artist)
    if label_keys & other: return True
    return any(_ratio(a, b) >= 90 for a in label_keys for b in other if min(len(a), len(b)) >= 4)


def split_artists(values):
    """Tag values -> artist list. Single strings like 'A, B' are split; 'Above & Beyond' is kept whole."""
    vals = [str(v).strip() for v in (values or []) if str(v).strip()]
    if len(vals) == 1 and re.search(r",|;|\sfeat\.?\s|\sft\.?\s", vals[0], re.I):
        vals = [p.strip() for p in re.split(r"(?i),|;|\sfeat\.?\s|\sft\.?\s", vals[0]) if p.strip()]
    return vals


# --- Catalog references (Deezer first, iTunes as second opinion) ---
def _deezer_ref(t, strong, via):
    alb = t.get("album") or {}
    return {"source": "deezer", "id": t.get("id"), "title": t.get("title") or "", "artist": (t.get("artist") or {}).get("name", ""),
            "album": alb.get("title", ""), "duration": int(t.get("duration") or 0), "preview": t.get("preview") or "",
            "isrc": t.get("isrc") or "", "cover": alb.get("cover_xl") or alb.get("cover_big") or "", "strong": strong, "via": via}


def _itunes_ref(t, strong):
    return {"source": "itunes", "id": t.get("trackId"), "title": t.get("trackName") or "", "artist": t.get("artistName") or "",
            "album": t.get("collectionName") or "", "duration": int(round((t.get("trackTimeMillis") or 0) / 1000)),
            "preview": t.get("previewUrl") or "", "isrc": "", "strong": strong, "via": "search",
            "cover": (t.get("artworkUrl100") or "").replace("100x100bb", "1400x1400bb")}


def itunes_references(label, allow_version_diff=False):
    title, artists = label.get("title") or "", label.get("artists") or []
    akeys = artist_keys(artists)
    term = f"{artists[0] if artists else ''} {title}".strip()
    if not term or not akeys: return []
    d = http_json("https://itunes.apple.com/search?entity=song&limit=15&term=" + urllib.parse.quote(term), host_gap=3.2)
    refs = []
    for t in (d or {}).get("results") or []:
        ok, exact = title_match(title, t.get("trackName"), allow_version_diff)
        if ok and artist_match(akeys, t.get("artistName")): refs.append(_itunes_ref(t, exact))
    return refs


def find_references(label, expected_duration=None, use_itunes=True, allow_version_diff=False):
    """Catalog entries for the song a label names. `strong` = ISRC or exact title+artist match."""
    title, artists = label.get("title") or "", label.get("artists") or []
    akeys = artist_keys(artists)
    refs, seen = [], set()

    def add(ref):
        key = (ref["source"], ref["id"])
        if ref["id"] and key not in seen:
            seen.add(key)
            refs.append(ref)

    isrc = str(label.get("isrc") or "").strip().upper()
    if re.fullmatch(r"[A-Z0-9]{12}", isrc):
        t = http_json("https://api.deezer.com/track/isrc:" + isrc)
        if t and t.get("id"):
            # A title that disagrees with its own ISRC means the tags were edited after download:
            # still worth comparing against, but not a trustworthy target.
            agrees = title_match(title, t.get("title"), True)[0]
            if agrees or artist_match(akeys, (t.get("artist") or {}).get("name")):
                add(_deezer_ref(t, agrees, "isrc"))
    if title and akeys:
        primary = artists[0]
        base = _FEAT_RE.sub(" ", title).strip()
        queries = ['artist:"%s" track:"%s"' % (primary.replace('"', ""), base.replace('"', "")), f"{primary} {base}"]
        for q in queries:
            d = http_json("https://api.deezer.com/search?limit=15&q=" + urllib.parse.quote(q))
            hit = False
            for t in (d or {}).get("data") or []:
                ok, exact = title_match(title, t.get("title"), allow_version_diff)
                if ok and artist_match(akeys, (t.get("artist") or {}).get("name")):
                    add(_deezer_ref(t, exact, "search"))
                    hit = True
            if hit: break
    if use_itunes and not any(r.get("preview") for r in refs):
        for r in itunes_references(label, allow_version_diff): add(r)

    def order(r):
        off = abs(r["duration"] - expected_duration) if expected_duration and r["duration"] else 0
        return (r["via"] != "isrc", not r["strong"], off)
    refs.sort(key=order)
    return refs


def ref_summary(ref):
    if not ref: return None
    return {k: ref.get(k) for k in ("source", "id", "title", "artist", "album", "duration", "isrc", "strong", "via")}


_ref_fp_cache = collections.OrderedDict()
_ref_fp_lock = threading.Lock()

def reference_fingerprint(ref):
    key = f"{ref.get('source')}:{ref.get('id')}"
    with _ref_fp_lock:
        if key in _ref_fp_cache:
            _ref_fp_cache.move_to_end(key)
            return _ref_fp_cache[key]
    data = fetch_bytes(ref.get("preview"))
    if not data: return []
    tmp = _work_path(".preview")
    try:
        tmp.write_bytes(data)
        fp = audio_fingerprint(tmp)
    finally:
        tmp.unlink(missing_ok=True)
    if fp:
        with _ref_fp_lock:
            _ref_fp_cache[key] = fp
            while len(_ref_fp_cache) > 400: _ref_fp_cache.popitem(last=False)
    return fp


def preview_fingerprints(refs, limit=3):
    out = []
    for r in refs:
        if len(out) >= limit: break
        if r.get("preview"):
            fp = reference_fingerprint(r)
            if len(fp) >= 60: out.append((r, fp))
    return out


def best_reference_match(sample_fp, prefs):
    best = (1.0, None, 0.0)
    for ref, rfp in prefs:
        ber, off = fingerprint_similarity(rfp, sample_fp)
        if ber < best[0]: best = (ber, ref, off)
    return best


def _fmt_dur(s):
    s = int(round(s or 0))
    return f"{s // 60}:{s % 60:02d}"


def _track_fp(path, duration, fps, full):
    """Fingerprint of a local file, memoized in `fps` (reads over the network mount are slow)."""
    if full and duration > FP_WINDOW_SEC + 10:
        if "full" not in fps: fps["full"] = audio_fingerprint(path)
        return fps["full"]
    if "window" not in fps: fps["window"] = audio_fingerprint(path, FP_WINDOW_SEC)
    return fps["window"]


def verify_file(path, label, duration, refs=None, second_opinion=True, fps=None):
    """Does the audio in `path` really contain the song `label` names?"""
    fps = {} if fps is None else fps
    if refs is None: refs = find_references(label)
    prefs = preview_fingerprints(refs)
    if not prefs:
        return {"status": "unverified", "reason": "No catalog preview found for this title/artist" if not refs else "Catalog entry has no audio preview"}
    fp = _track_fp(path, duration, fps, full=False)
    if not fp: return {"status": "error", "reason": "Could not decode audio"}
    ber, ref, off = best_reference_match(fp, prefs)
    if ber > FP_MATCH_BER and duration > FP_WINDOW_SEC + 10:
        fp = _track_fp(path, duration, fps, full=True) or fp
        ber, ref, off = min((ber, ref, off), best_reference_match(fp, prefs), key=lambda x: x[0])
    if ber > FP_MATCH_BER and second_opinion and not any(r["source"] == "itunes" for r, _ in prefs):
        # Ask a second catalog before calling the file wrong: Deezer may hold a different edit.
        extra = preview_fingerprints(itunes_references(label), limit=2)
        if extra:
            prefs += extra
            ber, ref, off = min((ber, ref, off), best_reference_match(fp, extra), key=lambda x: x[0])
    ref = ref or prefs[0][0]
    res = {"ber": round(ber, 3), "offset": round(off, 1), "ref": ref_summary(ref), "checked": len(prefs)}
    name = f"{ref['artist']} - {ref['title']}"
    if ber <= FP_MATCH_BER and ref.get("via") == "isrc" and not ref.get("strong"):
        # The audio is the song its ISRC names, but the title tag names something else. If that other
        # title is a real, different catalog song, the tags were rewritten; otherwise it's just spelling.
        if any(r.get("strong") and r["via"] != "isrc" for r in refs):
            res.update(status="tags_wrong", ref=ref_summary(dict(ref, strong=True)),
                       reason=f"Audio is '{name}' (the song its ISRC names) but the title tag says '{label.get('title')}'")
        else:
            res.update(status="ok", reason=f"Matches '{name}' by ISRC (the catalog spells the title differently)")
    elif ber <= FP_MATCH_BER:
        exp = ref.get("duration") or 0
        off_length = exp and duration and abs(duration - exp) > max(15, 0.10 * exp)
        if off_length and ref.get("via") == "isrc":
            res.update(status="wrong_version", reason=f"Right song, wrong cut: {_fmt_dur(duration)} long vs {_fmt_dur(exp)} for '{name}'")
        elif off_length:   # a title search can land on another edit (compilation, extended mix) of the same song
            res.update(status="ok", reason=f"Matches '{name}' (catalog edit is {_fmt_dur(exp)}, this file {_fmt_dur(duration)})")
        else:
            res.update(status="ok", reason=f"Matches '{name}'")
    elif ber >= FP_MISMATCH_BER:
        strong = any(r.get("strong") for r, _ in prefs)
        res.update(status="mismatch", confidence="high" if strong else "low",
                   reason=f"Audio is not '{name}' (fingerprint bit error {ber:.2f}; same song scores ~0.05)")
    else:
        res.update(status="uncertain", reason=f"Partial match with '{name}' (bit error {ber:.2f}): other master, edit or live take?")
    return res


def identify_by_title(path, title, duration, fps, album=""):
    """Which catalog song with this exact title is the audio? Catches right title, wrong artist."""
    base = _FEAT_RE.sub(" ", title).strip().replace('"', "")
    d = http_json("https://api.deezer.com/search?limit=25&q=" + urllib.parse.quote(f'track:"{base}"'))
    refs = []
    for t in (d or {}).get("data") or []:
        ok, exact = title_match(title, t.get("title"))
        if ok: refs.append(_deezer_ref(t, exact, "title"))
    akey = title_key(album)[0]
    refs.sort(key=lambda r: not (akey and title_key(r["album"])[0] == akey))   # same album first, else Deezer's ranking
    prefs = preview_fingerprints(refs, limit=6)
    if not prefs: return None
    ber, ref, _ = best_reference_match(_track_fp(path, duration, fps, full=False), prefs)
    if ber > FP_MATCH_BER and duration > FP_WINDOW_SEC + 10:
        ber, ref, _ = min((ber, ref, 0), best_reference_match(_track_fp(path, duration, fps, full=True), prefs), key=lambda x: x[0])
    return (ber, ref) if ber <= FP_MATCH_BER and ref else None


# --- Local files ---
_YT_ID_RE = re.compile(r"(?:[?&]v=|youtu\.be/|/shorts/)([A-Za-z0-9_-]{11})")

def read_track_tags(path):
    """Label and provenance of a local file, or None if unreadable."""
    from mutagen import File as MFile
    from mutagen.mp4 import MP4
    try: f = MFile(str(path))
    except Exception: return None
    if f is None: return None
    t = f.tags
    info = {"title": "", "artists": [], "album": "", "albumartist": "", "date": "", "tracknumber": "", "genre": "",
            "isrc": "", "comment": "", "source_page": "", "has_cover": False, "cover_bytes": 0,
            "duration": float(getattr(f.info, "length", 0) or 0)}

    def first(v): return str(v[0]).strip() if v else ""
    try:
        if t is not None and hasattr(t, "getall"):     # ID3
            def txt(fid):
                out = []
                for fr in t.getall(fid): out += [str(x) for x in getattr(fr, "text", [])]
                return [x for x in out if x.strip()]
            info.update(title=first(txt("TIT2")), artists=split_artists(txt("TPE1")),
                        album=first(txt("TALB")), albumartist=first(txt("TPE2")), date=first(txt("TDRC")), tracknumber=first(txt("TRCK")),
                        genre=first(txt("TCON")), isrc=first(txt("TSRC")), comment=first(txt("COMM")),
                        source_page=next((fr.url for fr in t.getall("WOAS")), ""))
            pics = t.getall("APIC")
            info.update(has_cover=bool(pics), cover_bytes=len(pics[0].data) if pics else 0)
        elif isinstance(f, MP4):
            tt = t or {}
            isrc = tt.get("----:com.apple.iTunes:ISRC") or []
            trkn = tt.get("trkn") or []
            info.update(title=first(tt.get("\xa9nam")), artists=split_artists(tt.get("\xa9ART")), album=first(tt.get("\xa9alb")),
                        albumartist=first(tt.get("aART")), date=first(tt.get("\xa9day")), genre=first(tt.get("\xa9gen")),
                        comment=first(tt.get("\xa9cmt")), isrc=bytes(isrc[0]).decode("utf-8", "ignore") if isrc else "",
                        tracknumber=str(trkn[0][0]) if trkn and trkn[0][0] else "")
            covr = tt.get("covr") or []
            info.update(has_cover=bool(covr), cover_bytes=len(covr[0]) if covr else 0)
        else:                                           # Vorbis comments (FLAC / Ogg)
            tt = t or {}
            def g(k):
                try: return [str(x) for x in (tt.get(k) or []) if str(x).strip()]
                except Exception: return []
            info.update(title=first(g("title")), artists=split_artists(g("artist")), album=first(g("album")),
                        albumartist=first(g("albumartist")), date=first(g("date")), tracknumber=first(g("tracknumber")),
                        genre=first(g("genre")), isrc=first(g("isrc")), comment=first(g("comment")), source_page=first(g("woas")))
            pics = getattr(f, "pictures", None) or []
            info.update(has_cover=bool(pics), cover_bytes=len(pics[0].data) if pics else 0)
    except Exception:
        pass
    m = _YT_ID_RE.search(info["comment"] or "")
    info["source_id"] = m.group(1) if m else ""
    return info


def _image_mime(data):
    return "image/png" if data[:8] == b"\x89PNG\r\n\x1a\n" else "image/jpeg"


def write_track_tags(path, meta, cover=None, only_missing=False, replace_cover=True, clear=()):
    """Write tags. meta keys: title, artists, album, albumartist, date, genre, tracknumber, discnumber,
    isrc, copyright, source_page, source_url. `clear` lists meta keys to delete."""
    from mutagen.flac import FLAC, Picture
    from mutagen.mp4 import MP4, MP4Cover, MP4FreeForm
    from mutagen.id3 import ID3, ID3NoHeaderError, TIT2, TPE1, TPE2, TALB, TDRC, TCON, TRCK, TPOS, TSRC, TCOP, WOAS, COMM, APIC
    vals = {k: v for k, v in (meta or {}).items() if v not in (None, "", [], 0)}
    as_list = lambda v: [str(x) for x in v] if isinstance(v, (list, tuple)) else [str(v)]
    ext = Path(path).suffix.lower()
    if ext == ".flac":
        f = FLAC(str(path))
        if f.tags is None: f.add_tags()
        keys = {"title": "title", "artists": "artist", "album": "album", "albumartist": "albumartist", "date": "date",
                "genre": "genre", "tracknumber": "tracknumber", "discnumber": "discnumber", "isrc": "isrc",
                "copyright": "copyright", "source_page": "woas", "source_url": "comment"}
        for k in clear:
            if keys.get(k) and keys[k] in f.tags: del f.tags[keys[k]]
        for k, tag in keys.items():
            if k in vals and not (only_missing and f.tags.get(tag)): f.tags[tag] = as_list(vals[k])
        if cover and (replace_cover or not f.pictures):
            pic = Picture()
            pic.type, pic.mime, pic.desc, pic.data = 3, _image_mime(cover), "Front Cover", cover
            f.clear_pictures()
            f.add_picture(pic)
        f.save()
    elif ext == ".mp3":
        try: tags = ID3(str(path))
        except ID3NoHeaderError: tags = ID3()
        frames = {"title": TIT2, "artists": TPE1, "album": TALB, "albumartist": TPE2, "date": TDRC, "genre": TCON,
                  "tracknumber": TRCK, "discnumber": TPOS, "isrc": TSRC, "copyright": TCOP}
        fids = dict({k: c.__name__ for k, c in frames.items()}, source_page="WOAS", source_url="COMM")
        for k in clear:
            if k in fids: tags.delall(fids[k])
        for k, cls in frames.items():
            if k in vals and not (only_missing and tags.getall(cls.__name__)):
                tags.setall(cls.__name__, [cls(encoding=3, text=as_list(vals[k]))])
        if "source_page" in vals and not (only_missing and tags.getall("WOAS")): tags.setall("WOAS", [WOAS(url=str(vals["source_page"]))])
        if "source_url" in vals and not (only_missing and tags.getall("COMM")):
            tags.setall("COMM", [COMM(encoding=3, lang="eng", desc="", text=[str(vals["source_url"])])])
        if cover and (replace_cover or not tags.getall("APIC")):
            tags.setall("APIC", [APIC(encoding=3, mime=_image_mime(cover), type=3, desc="Front Cover", data=cover)])
        tags.save(str(path))
    elif ext in (".m4a", ".mp4"):
        f = MP4(str(path))
        if f.tags is None: f.add_tags()
        keys = {"title": "\xa9nam", "artists": "\xa9ART", "album": "\xa9alb", "albumartist": "aART", "date": "\xa9day",
                "genre": "\xa9gen", "copyright": "cprt", "source_url": "\xa9cmt"}
        for k in clear:
            if keys.get(k) and keys[k] in f.tags: del f.tags[keys[k]]
        for k, tag in keys.items():
            if k in vals and not (only_missing and f.tags.get(tag)): f.tags[tag] = as_list(vals[k])
        for k, tag in (("tracknumber", "trkn"), ("discnumber", "disk")):
            nums = re.findall(r"\d+", str(vals.get(k, "")))
            if nums and not (only_missing and f.tags.get(tag)):
                f.tags[tag] = [(int(nums[0]), int(nums[1]) if len(nums) > 1 else 0)]
        if "isrc" in vals and not (only_missing and f.tags.get("----:com.apple.iTunes:ISRC")):
            f.tags["----:com.apple.iTunes:ISRC"] = [MP4FreeForm(str(vals["isrc"]).encode())]
        if cover and (replace_cover or not f.tags.get("covr")):
            fmt = MP4Cover.FORMAT_PNG if _image_mime(cover) == "image/png" else MP4Cover.FORMAT_JPEG
            f.tags["covr"] = [MP4Cover(cover, imageformat=fmt)]
        f.save()






def install_library_file(src, rel):
    """Copy a finished file to `rel` in the library; watchers never see a partial audio file."""
    dest = Path(get_real_music_dir()) / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(f".{dest.name}.axdio-tmp")
    shutil.copyfile(src, tmp)
    try:
        os.replace(tmp, dest)
    except OSError:
        dest.unlink(missing_ok=True)
        os.rename(tmp, dest)
    return dest


def refresh_library_entry(rel):
    p = Path(get_real_music_dir()) / rel
    try: (COVERS_CACHE_DIR / f"{hashlib.md5(rel.encode()).hexdigest()}.jpg").unlink(missing_ok=True)
    except Exception: pass
    with library_cache_lock:
        if p.is_file(): library_cache_data[rel] = extract_tags_for_file(p, rel)
        else: library_cache_data.pop(rel, None)
    save_and_rebuild_cache()


def reference_metadata(ref):
    """Full tag set for a catalog reference."""
    if not ref: return {}
    if ref.get("source") == "deezer":
        t = http_json(f"https://api.deezer.com/track/{ref['id']}") or {}
        if not t.get("id"): return {}
        alb = http_json(f"https://api.deezer.com/album/{(t.get('album') or {}).get('id')}") or {}
        contributors = [c.get("name") for c in t.get("contributors") or [] if c.get("name")]
        genres = [g.get("name") for g in (alb.get("genres") or {}).get("data") or [] if g.get("name")]
        return {"title": t.get("title"), "artists": contributors or [(t.get("artist") or {}).get("name")],
                "album": (t.get("album") or {}).get("title"), "albumartist": (alb.get("artist") or {}).get("name"),
                "date": t.get("release_date") or alb.get("release_date"), "tracknumber": t.get("track_position"),
                "discnumber": t.get("disk_number"), "isrc": t.get("isrc"), "genre": genres[0] if genres else "",
                "copyright": alb.get("label"), "cover_url": alb.get("cover_xl") or (t.get("album") or {}).get("cover_xl")}
    d = http_json(f"https://itunes.apple.com/lookup?id={ref['id']}", host_gap=3.2) or {}
    t = next(iter(d.get("results") or []), {})
    if not t: return {}
    return {"title": t.get("trackName"), "artists": [t.get("artistName")], "album": t.get("collectionName"),
            "albumartist": t.get("collectionArtistName") or t.get("artistName"), "date": (t.get("releaseDate") or "")[:10],
            "tracknumber": t.get("trackNumber"), "discnumber": t.get("discNumber"), "genre": t.get("primaryGenreName"),
            "copyright": t.get("copyright"), "cover_url": (t.get("artworkUrl100") or "").replace("100x100bb", "1400x1400bb")}

















def _credit_pieces(names):
    out = set()
    for n in names or []:
        for piece in re.split(r"(?i)\s*(?:,|;|/|&|\+|\bx\b|\band\b|\bwith\b|\bfeat\.?|\bft\.?|\bfeaturing\b)\s*", str(n or "")):
            if _norm(piece): out.add(_norm(piece))
    return out


def title_features(title):
    """Artists a title credits: 'Get Lucky (feat. Pharrell Williams & Nile Rodgers)' -> Pharrell Williams, Nile Rodgers."""
    return [m.group(1) for m in re.finditer(r"(?i)(?:feat\.?|ft\.?|featuring|with)\s+([^\)\]]+)", str(title or ""))]


def same_credits(target_artists, target_title, ref_artist, ref_title, strict=True):
    """Does an entry credit the same artists? A version 'feat. DaBaby' is another recording than the solo one.
    Catalogs often leave featured artists out of an entry, so with strict=False an entry may credit fewer artists than the
    target (never more); strict=True also wants every artist the target's title features."""
    tgt = _credit_pieces(list(target_artists or []) + title_features(target_title))
    ref = _credit_pieces([ref_artist] + title_features(ref_title))
    if not tgt or not ref: return False
    close = lambda a, pool: a in pool or any(min(len(a), len(b)) >= 4 and _ratio(a, b) >= 90 for b in pool)
    primary = _credit_pieces(list(target_artists or [])[:1])
    named = _credit_pieces(title_features(target_title))        # 'Song (feat. X)' needs X credited too
    return any(close(p, ref) for p in primary) and all(close(r, tgt) for r in ref) and (not strict or all(close(f, ref) for f in named))






























# ============================================================
# LIBRARY AUDIT & REPAIR
# Fingerprints every track against the catalog preview of the song its tags name.
# Wrong audio is replaced by a fingerprint-verified download (original kept in
# config/quarantine, same library path so likes/playlists stay valid); tracks whose
# tags were rewritten to another song are re-tagged from the song they really are.
# ============================================================
AUDIT_FINAL = {"ok", "mismatch", "wrong_version", "tags_wrong", "uncertain", "unverified", "ignored", "fixed"}
AUDIT_FIXABLE = {"mismatch", "wrong_version", "tags_wrong", "uncertain"}
audit_lock = threading.RLock()
quarantine_lock = threading.Lock()
audit_db = _load_json_file(AUDIT_DB_FILE, {})
audit_dirty = 0
audit_stop = threading.Event()
audit_state = {"status": "idle", "logs": collections.deque(maxlen=600), "scanned": 0, "total": 0, "cached": 0,
               "counts": {}, "current": "", "started_at": 0, "options": {}, "fixing": "", "fix_queue": 0}
fix_queue = collections.deque()
fix_thread = None


def audit_log(msg):
    audit_state["logs"].append(time.strftime("%H:%M:%S ") + msg)


def audit_put(rel, entry, flush=False):
    global audit_dirty
    with audit_lock:
        audit_db[rel] = entry
        audit_dirty += 1
        if flush or audit_dirty >= 20:
            _save_json_file(AUDIT_DB_FILE, audit_db)
            audit_dirty = 0


def audit_flush():
    global audit_dirty
    with audit_lock:
        _save_json_file(AUDIT_DB_FILE, audit_db)
        audit_dirty = 0


def path_label(rel):
    """What the folder layout says a file is: Artist/Album/NN - Title.ext, or Folder/Artist - Title.ext."""
    parts = rel.replace("\\", "/").split("/")
    stem = re.sub(r"\s*\[[A-Za-z0-9_-]{11}\]$", "", os.path.splitext(parts[-1])[0])   # yt-dlp's [videoid] suffix
    stem = re.sub(r"^\d{1,3}\s*[-._]\s*", "", stem).strip()
    if not stem: return None
    if " - " in stem and len(parts) < 3:
        artist, title = [x.strip() for x in stem.split(" - ", 1)]
    elif len(parts) >= 2:
        artist, title = parts[0], stem
    else:
        return None
    return {"title": title, "artists": [artist], "album": parts[-2] if len(parts) >= 3 else "", "isrc": ""}


def _label_text(label):
    return f"{', '.join(label.get('artists') or []) or '?'} - {label.get('title') or '?'}"


def audit_track(rel, recheck=False):
    """Audit one library file. Returns (entry, from_cache)."""
    p = Path(get_real_music_dir()) / rel
    try: st = p.stat()
    except OSError:
        with audit_lock: audit_db.pop(rel, None)
        return None, True
    with audit_lock: prev = audit_db.get(rel)
    unchanged = prev and prev.get("mtime") == st.st_mtime and prev.get("size") == st.st_size
    if unchanged and (prev.get("status") == "ignored" or (not recheck and prev.get("status") in AUDIT_FINAL)):
        return prev, True
    entry = {"mtime": st.st_mtime, "size": st.st_size, "checked_at": time.time()}
    tags = read_track_tags(p)
    if not tags:
        entry.update(status="error", reason="Unreadable audio file")
    elif not tags["title"] or not tags["artists"]:
        entry.update(status="unverified", reason="No title/artist tags", duration=round(tags["duration"], 1), source_id=tags["source_id"])
        pl = path_label(rel)
        if pl:
            alt = verify_file(p, pl, tags["duration"], second_opinion=False)
            if alt["status"] == "ok" and (alt.get("ref") or {}).get("strong"):
                entry.update(alt, status="tags_wrong", reason=f"File has no title/artist tags; audio is '{alt['ref']['artist']} - {alt['ref']['title']}'")
    else:
        label = {"title": tags["title"], "artists": tags["artists"], "album": tags["album"], "isrc": tags["isrc"]}
        entry.update(label={"title": tags["title"], "artist": ", ".join(tags["artists"]), "album": tags["album"], "isrc": tags["isrc"]},
                     duration=round(tags["duration"], 1), source_id=tags["source_id"])
        fps, refs = {}, find_references(label)
        # A source page link or an ISRC written at download time names the song that was asked for.
        # Without them (or when the title contradicts its own ISRC) the tags were guessed or edited later.
        isrc_ref = next((r for r in refs if r["via"] == "isrc"), None)
        trusted = bool(tags["source_page"] or tags["isrc"]) and (isrc_ref is None or isrc_ref["strong"])
        res = verify_file(p, label, tags["duration"], refs=refs, fps=fps)
        if res["status"] in ("mismatch", "unverified", "uncertain") and not trusted:
            res = _identify_audio(p, rel, label, tags["duration"], fps, res) or res
        if res["status"] == "mismatch":
            res["confidence"] = "high" if trusted and res.get("confidence") == "high" else "low"
            if not trusted: res["reason"] += ". The tags look guessed or hand-edited, so review before replacing"
        entry.update(res, trusted=trusted)
    if prev and prev.get("fix"):
        entry.update(fix=prev["fix"], fixed_at=prev.get("fixed_at"))
        if entry.get("status") == "ok": entry["status"] = "fixed"   # repaired and still verifies
    audit_put(rel, entry)
    return entry, False


def _identify_audio(p, rel, label, duration, fps, res):
    """Name the audio from its file path or its title alone; fingerprints confirm either way."""
    def wrong_tags(ref, ber, how):
        return {"status": "tags_wrong", "ber": round(ber, 3), "ref": ref_summary(dict(ref, strong=True)), "tag_ber": res.get("ber"),
                "reason": f"Audio is '{ref['artist']} - {ref['title']}' ({how}) but tags say '{_label_text(label)}'"}
    pl = path_label(rel)
    if pl and (title_key(pl["title"])[0] != title_key(label["title"])[0] or not (artist_keys(pl["artists"]) & artist_keys(label["artists"]))):
        alt = verify_file(p, pl, duration, second_opinion=False, fps=fps)
        if alt["status"] == "ok" and (alt.get("ref") or {}).get("strong"):
            return wrong_tags(alt["ref"], alt["ber"], "as its file path says")
    hit = identify_by_title(p, label["title"], duration, fps, album=label.get("album") or (pl or {}).get("album") or "")
    if hit:
        ber, ref = hit
        if artist_match(artist_keys(label["artists"]), ref["artist"]):
            return {"status": "ok", "ber": round(ber, 3), "ref": ref_summary(ref), "reason": f"Matches '{ref['artist']} - {ref['title']}'"}
        return wrong_tags(ref, ber, "same title, different artist")
    return None


def _auto_fixable(e):
    s = (e or {}).get("status")
    if s == "mismatch": return e.get("confidence") == "high"
    if s == "wrong_version": return ((e.get("ref") or {}).get("via")) == "isrc"
    return s == "tags_wrong"


def _audit_order(rels):
    """Most suspicious first: title tag differs from the file name, or an old auto-fix touched it."""
    with library_cache_lock:
        def key(rel):
            e = library_cache_data.get(rel) or {}
            stem = re.sub(r"^\d{1,3}\s*[-._]\s*", "", os.path.splitext(os.path.basename(rel))[0])
            return (title_key(e.get("title") or "")[0] == title_key(stem)[0], not e.get("autofixed"), rel.lower())
        return sorted(rels, key=key)


def _run_audit_job(opts):
    try:
        _audit_job_body(opts)
    except Exception as e:
        audit_state["status"] = "error"
        audit_log(f"[ERR] Audit crashed: {e}")
        audit_log(traceback.format_exc())


def _audit_job_body(opts):
    audit_stop.clear()
    scope = (opts.get("scope") or "").strip().lower()
    rels = scope_rels(opts)
    if scope: rels = [r for r in rels if scope in r.lower()]
    rels = _audit_order(rels)
    counts = collections.Counter()
    audit_state.update(total=len(rels), scanned=0, cached=0, counts={}, current="", started_at=time.time())
    chosen = f" in {scope_text(opts)}" if opts.get("paths") or opts.get("artists") else ""
    audit_log(f"[INIT] Auditing {len(rels)} tracks{chosen}{' matching ' + repr(scope) if scope else ''} with {opts['workers']} worker(s)"
              f"{' — re-checking everything' if opts['recheck'] else ' — already-verified tracks are skipped'}"
              f"{'; confirmed mismatches are replaced automatically' if opts['auto_fix'] else ''}.")
    it, it_lock = iter(rels), threading.Lock()

    def worker():
        while not audit_stop.is_set():
            with it_lock: rel = next(it, None)
            if rel is None: return
            audit_state["current"] = rel
            try:
                entry, cached = audit_track(rel, opts["recheck"])
            except Exception as e:
                entry, cached = {"status": "error", "reason": str(e)[:200]}, False
            if entry is None: continue
            st = entry.get("status", "error")
            with audit_lock:
                audit_state["scanned"] += 1
                audit_state["cached"] += 1 if cached else 0
                counts[st] += 1
                audit_state["counts"] = dict(counts)
                n = audit_state["scanned"]
            if not cached and st not in ("ok", "unverified", "fixed"):
                audit_log(f"[{st.upper()}] {rel} — {entry.get('reason', '')}")
            if opts["auto_fix"] and _auto_fixable(entry): enqueue_fix([rel])
            if n % 100 == 0:
                audit_log(f"[PROGRESS] {n}/{len(rels)} · " + " · ".join(f"{k} {v}" for k, v in sorted(counts.items())))

    threads = [threading.Thread(target=worker, daemon=True) for _ in range(opts["workers"])]
    for t in threads: t.start()
    for t in threads: t.join()
    audit_flush()
    audit_state["current"] = ""
    while opts["auto_fix"] and not audit_stop.is_set() and (fix_queue or audit_state["fixing"]): time.sleep(2)
    audit_state["status"] = "stopped" if audit_stop.is_set() else "completed"
    audit_log(f"[FINISH] {audit_state['scanned']}/{len(rels)} checked · " + " · ".join(f"{k} {v}" for k, v in sorted(counts.items())))


def enqueue_fix(rels):
    global fix_thread
    with audit_lock:
        for r in rels:
            if r not in fix_queue and r != audit_state["fixing"]: fix_queue.append(r)
        audit_state["fix_queue"] = len(fix_queue)
        if fix_thread is None or not fix_thread.is_alive():
            fix_thread = threading.Thread(target=_fix_worker, daemon=True)
            fix_thread.start()


def _fix_worker():
    while True:
        with audit_lock:
            if not fix_queue or audit_stop.is_set():
                fix_queue.clear()
                audit_state.update(fixing="", fix_queue=0)
                return
            rel = fix_queue.popleft()
            audit_state.update(fixing=rel, fix_queue=len(fix_queue))
        try:
            repair_track(rel)
        except YouTubeBlocked:
            audit_log("[ERR] YouTube is asking for bot verification — repairs paused. Try again in an hour.")
            with audit_lock: fix_queue.clear()
        except PluginMissing as e:
            audit_log(f"[ERR] {e}")
            with audit_lock: fix_queue.clear()
        except Exception as e:
            audit_log(f"[ERR] Repair of {rel} failed: {str(e)[:200]}")
        time.sleep(2)


def quarantine_original(rel, reason, extra):
    src = Path(get_real_music_dir()) / rel
    qid = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
    dst = QUARANTINE_DIR / qid / Path(rel).name
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dst)
    item = dict(extra, id=qid, rel_path=rel, file=str(dst), reason=reason, at=time.time())
    with quarantine_lock:
        idx = _load_json_file(QUARANTINE_INDEX, [])
        idx.insert(0, item)
        _save_json_file(QUARANTINE_INDEX, idx)
    return item


def _mark_fixed(rel, entry, fix, **fields):
    st = (Path(get_real_music_dir()) / rel).stat()
    new = dict(entry, mtime=st.st_mtime, size=st.st_size, status="fixed", fixed_at=time.time(), fix=fix, **fields)
    new.pop("fix_error", None)
    audit_put(rel, new, flush=True)


def repair_track(rel):
    p = Path(get_real_music_dir()) / rel
    if not p.is_file():
        audit_log(f"[SKIP] {rel} no longer exists")
        return False
    with audit_lock: entry = dict(audit_db.get(rel) or {})
    st = p.stat()
    if entry.get("mtime") != st.st_mtime or entry.get("size") != st.st_size:
        entry, _ = audit_track(rel, recheck=True)
        entry = dict(entry or {})
    if entry.get("status") not in AUDIT_FIXABLE:
        audit_log(f"[SKIP] {rel}: nothing to repair ({entry.get('status')})")
        return False
    if entry["status"] == "tags_wrong": return _retag_from_reference(rel, p, entry)
    tags = read_track_tags(p)
    if not tags or not tags["title"] or not tags["artists"]:
        audit_log(f"[SKIP] {rel}: no title/artist tags to say which song it should be")
        return False
    fix = plugin_hook("replace_audio")        # the Downloader plugin fetches the right recording
    if not fix:
        audit_log(f"[SKIP] {rel}: replacing wrong audio needs the Downloader plugin (Plugins)")
        return False
    return fix[0](rel, p, entry, tags)


def _retag_from_reference(rel, p, entry):
    ref = entry.get("ref") or {}
    meta = reference_metadata(ref)
    if not meta.get("title"):
        audit_log(f"[FAILED] {rel}: could not load catalog details for '{ref.get('artist')} - {ref.get('title')}'")
        return False
    q = quarantine_original(rel, entry.get("reason"), {"kind": "tags"})
    cover = fetch_bytes(meta.pop("cover_url", None))
    write_track_tags(p, meta, cover=cover, replace_cover=bool(cover), clear=("source_page",))
    refresh_library_entry(rel)
    _mark_fixed(rel, entry, {"kind": "retagged", "quarantine_id": q["id"]},
                label={"title": meta["title"], "artist": ", ".join(a for a in meta["artists"] if a), "album": meta.get("album"), "isrc": meta.get("isrc")})
    audit_log(f"[FIXED] {rel}: re-tagged as '{', '.join(a for a in meta['artists'] if a)} - {meta['title']}' (audio verified)")
    return True




def restore_quarantined(qid):
    with quarantine_lock:
        idx = _load_json_file(QUARANTINE_INDEX, [])
        item = next((i for i in idx if i.get("id") == qid), None)
    if not item: raise ValueError("Quarantine entry not found")
    src = Path(item["file"])
    if not src.is_file(): raise ValueError("Quarantined file is missing")
    rel = item["rel_path"]
    install_library_file(src, rel)
    refresh_library_entry(rel)
    p = Path(get_real_music_dir()) / rel
    st, tags = p.stat(), read_track_tags(p) or {}
    audit_put(rel, {"status": "ignored", "reason": "Restored from quarantine by an admin", "mtime": st.st_mtime, "size": st.st_size,
                    "label": {"title": tags.get("title"), "artist": ", ".join(tags.get("artists") or []), "album": tags.get("album"), "isrc": tags.get("isrc")},
                    "source_id": tags.get("source_id"), "checked_at": time.time()}, flush=True)
    purge_quarantined(qid)
    return rel


def purge_quarantined(qid=None):
    with quarantine_lock:
        idx = _load_json_file(QUARANTINE_INDEX, [])
        keep = [i for i in idx if qid and i.get("id") != qid]
        for i in idx:
            if i not in keep: shutil.rmtree(Path(i["file"]).parent, ignore_errors=True)
        _save_json_file(QUARANTINE_INDEX, keep)
    return len(idx) - len(keep)


# --- METADATA & ARTWORK FIXER ---
# Fills in missing album / artwork / track numbers from the catalog entry of the SAME song:
# the file's own ISRC, or an exact title+artist match whose audio fingerprint agrees.
# It never renames a track; that is how the old scraper mislabeled songs.
def _fixer_log(msg):
    admin_scrape_state["logs"].append(msg)


def _fix_metadata_for(rel, force_all):
    p = Path(get_real_music_dir()) / rel
    if not force_all:
        with library_cache_lock: e = dict(library_cache_data.get(rel) or {})
        cover_cached = (COVERS_CACHE_DIR / f"{hashlib.md5(rel.encode()).hexdigest()}.jpg").exists()
        if cover_cached and e.get("album") and e.get("album") not in ("Singles", "Single") and e.get("track_number"): return "complete"
    tags = read_track_tags(p)
    if not tags: return "error"
    low_res = tags["has_cover"] and tags["cover_bytes"] < 40 * 1024
    missing = [k for k in ("album", "tracknumber") if not tags[k]] + ([] if tags["has_cover"] else ["cover"])
    if force_all and low_res: missing.append("hi-res cover")
    if not missing: return "complete"
    name = f"{', '.join(tags['artists']) or '?'} - {tags['title'] or os.path.basename(rel)}"
    if not tags["title"] or not tags["artists"]:
        _fixer_log(f"  [SKIP] {rel}: no title/artist tags to look up")
        return "skipped"
    label = {"title": tags["title"], "artists": tags["artists"], "album": tags["album"], "isrc": tags["isrc"]}
    refs = [r for r in find_references(label) if r.get("strong")]
    if not refs:
        _fixer_log(f"  [NOT FOUND] {name}: no exact catalog match")
        return "skipped"
    ref = refs[0]
    if ref["via"] != "isrc":
        st = p.stat()
        with audit_lock: prev = audit_db.get(rel) or {}
        if not (prev.get("status") == "ok" and prev.get("mtime") == st.st_mtime):
            res = verify_file(p, label, tags["duration"], refs=refs)
            audit_put(rel, dict(res, mtime=st.st_mtime, size=st.st_size, checked_at=time.time(), duration=round(tags["duration"], 1),
                                label={"title": tags["title"], "artist": ", ".join(tags["artists"]), "album": tags["album"], "isrc": tags["isrc"]}))
            if res["status"] != "ok":
                _fixer_log(f"  [FLAGGED] {name}: {res.get('reason')} — left untouched, see Library Audit")
                return "flagged"
            ref = next((r for r in refs if r["id"] == (res.get("ref") or {}).get("id")), ref)
    meta = reference_metadata(ref)
    if not meta: return "skipped"
    cover = fetch_bytes(meta.pop("cover_url", None)) if ("cover" in missing or "hi-res cover" in missing) else None
    fill = {k: meta.get(k) for k in ("album", "albumartist", "date", "tracknumber", "discnumber", "genre", "isrc")}
    write_track_tags(p, fill, cover=cover, only_missing=True, replace_cover="hi-res cover" in missing)
    refresh_library_entry(rel)
    with audit_lock: prev = audit_db.get(rel)
    if prev and prev.get("status") == "ok":
        st = p.stat()
        audit_put(rel, dict(prev, mtime=st.st_mtime, size=st.st_size))
    _fixer_log(f"  [SUCCESS] {name}: filled {', '.join(missing)} from {ref['source'].title()} ({'ISRC' if ref['via'] == 'isrc' else 'fingerprint-verified'})")
    return "fixed"


def _run_scrape_task(music_dir, force_all=False, scope=None):
    with scrape_lock:
        admin_scrape_state.update(status="scraping", scraped=0, scanned=0)
        admin_scrape_state["logs"].clear()
    rels = sorted(scope_rels(scope or {}), key=str.lower)
    admin_scrape_state["total"] = len(rels)
    _fixer_log(f"[INIT] Checking {len(rels)} tracks in {scope_text(scope or {})} for missing album, track number or artwork"
               f"{' and low-resolution covers' if force_all else ''}. Titles and artists are never changed.")
    counts = collections.Counter()
    it, it_lock = iter(rels), threading.Lock()

    def worker():
        while True:
            with it_lock: rel = next(it, None)
            if rel is None: return
            try: r = _fix_metadata_for(rel, force_all)
            except (YouTubeBlocked, PluginMissing): r = "error"
            except Exception as e:
                r = "error"
                _fixer_log(f"  [ERR] {rel}: {str(e)[:160]}")
            with scrape_lock:
                counts[r] += 1
                admin_scrape_state["scanned"] += 1
                admin_scrape_state["scraped"] = counts["fixed"]
                n = admin_scrape_state["scanned"]
            if n % 250 == 0: _fixer_log(f"[PROGRESS] {n}/{len(rels)} · " + " · ".join(f"{k} {v}" for k, v in sorted(counts.items())))

    threads = [threading.Thread(target=worker, daemon=True) for _ in range(3)]
    for t in threads: t.start()
    for t in threads: t.join()
    audit_flush()
    with scrape_lock:
        admin_scrape_state["status"] = "completed"
    _fixer_log(f"[FINISH] Updated {counts['fixed']} · already complete {counts['complete']} · flagged {counts['flagged']} · "
               f"not found {counts['skipped']} · errors {counts['error']}")








# --- CHOOSING WHAT A JOB COVERS ---
# The audit, the metadata fixer and the tag fixer can each run on the whole library, or on chosen folders, files and
# artists (as the library's tags name them). Songs shared by other servers are never included: their files aren't here.
def scope_rels(d):
    paths = [str(x).replace("\\", "/").strip("/") for x in (d.get("paths") or []) if str(x).strip("/")][:500]
    artists = {_norm(a) for a in (d.get("artists") or []) if _norm(a)}
    with library_cache_lock:
        items = [(r, v) for r, v in library_cache_data.items() if isinstance(v, dict) and not r.startswith("@")]
    if not paths and not artists: return [r for r, _ in items]
    return [r for r, v in items
            if any(r == p or r.startswith(p + "/") for p in paths)
            or (artists and (_norm(v.get("artist")) in artists or _norm(v.get("album_artist")) in artists))]

def scope_text(d):
    """How a job's scope reads in its log."""
    parts = [f"'{p}'" for p in (d.get("paths") or [])[:3]] + [f"artist {a}" for a in (d.get("artists") or [])[:3]]
    more = len(d.get("paths") or []) + len(d.get("artists") or []) - len(parts)
    return (", ".join(parts) + (f" and {more} more" if more > 0 else "")) if parts else "the whole library"

@app.route("/api/admin/library/scope")
def api_admin_library_scope():
    """Folders and artists to choose from for a job, matching what the admin types."""
    q = _norm(request.args.get("q", ""))
    folders, artists = collections.Counter(), collections.Counter()
    names = {}
    with library_cache_lock:
        for rel, v in library_cache_data.items():
            if not isinstance(v, dict) or rel.startswith("@"): continue
            parts = rel.split("/")[:-1]
            for i in range(1, min(len(parts), 3) + 1): folders["/".join(parts[:i])] += 1
            a = v.get("artist") or ""
            if a:
                artists[_norm(a)] += 1
                names.setdefault(_norm(a), a)
    fl = [f for f in folders if not q or q in _norm(f)]
    fl.sort(key=lambda f: (f.count("/"), f.lower()))
    al = [k for k in artists if k and (not q or q in k)]
    al.sort(key=lambda k: (-artists[k], names[k].lower()))
    return jsonify({"folders": [{"path": f, "songs": folders[f]} for f in fl[:60]],
                    "artists": [{"name": names[k], "songs": artists[k]} for k in al[:40]]})


# --- TITLES & TAGS: fix a folder, a file or chosen artists ---
# Titles often carry things that aren't the title: the artist ("NERO - 2808" by NERO), a track number taken from the
# file name, yt-dlp's [video id], or "(Official Video)". Songs without tags get their title and artist from the path.
# Then the catalog is asked which song the audio is, by fingerprint, and that song's title and artists are written,
# with the album, track number, date and cover filled in where they're missing. Without a confirmed match only the
# cleanup is applied. Every change is recorded (config/tag_fixes.json) so it can be undone.
TAGFIX_HISTORY = CONFIG_DIR / "tag_fixes.json"
tagfix_state = {"status": "idle", "logs": collections.deque(maxlen=800), "total": 0, "scanned": 0, "changed": 0, "results": [],
                "scope": "", "quick": False, "started_at": 0}
tagfix_lock = threading.RLock()
tagfix_stop = threading.Event()
_history_lock = threading.Lock()

_TITLE_SPLIT_RE = re.compile(r"^(.+?)\s+[-–—]\s+(.+)$")
_TITLE_TRACKNO_RE = re.compile(r"^(\d{1,3})\s*[-._]\s+(?=\S)")
_TITLE_VIDEO_ID_RE = re.compile(r"\s*\[[A-Za-z0-9_-]{11}\]$")
# "(Official Video)", "(Official Music Video)", "(Lyric Video)", "(Lyrics)", "(Official Audio)", "(Visualizer)", "[HD]"
_TITLE_VIDEO_RE = re.compile(r"(?i)\s*[\(\[]\s*(?:official\s+)?(?:(?:(?:music|lyrics?)\s+)?(?:video|audio|visuali[sz]er)|lyrics?|hd|hq|4k)\s*[\)\]]\s*$")
TAGFIX_KEYS = ("title", "artists", "album", "albumartist", "date", "tracknumber", "discnumber", "isrc", "genre")

def clean_label(tags, rel):
    """What the title and artists should be, judging only by the tags and the path. Returns (label, what was cleaned)."""
    pl = path_label(rel) or {}
    title = (tags.get("title") or "").strip()
    artists = [a for a in tags.get("artists") or [] if a]
    notes = []
    if not title and pl.get("title"):
        title = pl["title"]
        notes.append("title from the file name")
    if not artists and pl.get("artists"):
        artists = list(pl["artists"])
        notes.append("artist from the folder")
    t = _TITLE_VIDEO_ID_RE.sub("", title)
    if t != title: notes.append("video id")
    m = _TITLE_TRACKNO_RE.match(t)
    if m:
        n, tn = int(m.group(1)), str(tags.get("tracknumber") or "").split("/")[0].strip()
        if not tn or (tn.isdigit() and int(tn) == n):
            t = t[m.end():]
            notes.append("track number")
    # "Artist - Title", when that artist is this song's: its artist tag, album artist or the folder it's filed under.
    m = _TITLE_SPLIT_RE.match(t)
    own = artists + [tags.get("albumartist") or "", rel.split("/")[0] if "/" in rel else ""]
    if m and any(_norm(m.group(1)) == _norm(a) for a in own if _norm(a)):
        t = m.group(2).strip()
        notes.append("artist in the title")
    for _ in range(2):
        t2 = _TITLE_VIDEO_RE.sub("", t).strip()
        if t2 and t2 != t:
            t = t2
            if "video label" not in notes: notes.append("video label")
    return {"title": t.strip(), "artists": artists, "album": tags.get("album") or pl.get("album") or "", "isrc": tags.get("isrc") or ""}, notes

_ORIGINAL_RE = re.compile(r"(?i)\s*(?:[\(\[]\s*original(?:\s+(?:mix|version))?\s*[\)\]]|\s-\s*original(?:\s+(?:mix|version))?)\s*$")

def _spelling(s):
    """A title as written, apart from capitals, spacing and the kind of quotes and dashes."""
    s = str(s or "").translate(str.maketrans({"’": "'", "‘": "'", "“": '"', "”": '"', "–": "-", "—": "-"}))
    return re.sub(r"\s+", " ", s).strip().casefold()

def _prefer_title(mine, catalog):
    if not mine: return catalog
    if _spelling(mine) in (_spelling(catalog), _spelling(_ORIGINAL_RE.sub("", catalog))): return mine
    return catalog

def _prefer_artists(mine, catalog):
    """The catalog's artists, spelled the way this library spells those it already has ("NERO", not "Nero")."""
    return [next((m for m in mine if _norm(m) == _norm(a)), a) for a in catalog if a] or mine

def _tag_value(v):
    if isinstance(v, (list, tuple)): return [str(x).strip() for x in v if str(x).strip()]
    return str(v or "").strip()

def _record_fix(rel, before, after, how, cover_added):
    item = {"id": time.strftime("%Y%m%d%H%M%S-") + uuid.uuid4().hex[:6], "rel": rel, "at": time.time(),
            "before": before, "after": after, "how": how, "cover_added": cover_added}
    with _history_lock:
        hist = _load_json_file(TAGFIX_HISTORY, [])
        hist.insert(0, item)
        _save_json_file(TAGFIX_HISTORY, hist[:20000])
    return item["id"]

def fix_track(rel, quick=False):
    """Clean up one song's title and tags, and (unless `quick`) confirm them with the catalog. Returns what happened."""
    p = Path(get_real_music_dir()) / rel
    tags = read_track_tags(p)
    out = {"rel": rel, "before": {"title": (tags or {}).get("title") or "", "artist": ", ".join((tags or {}).get("artists") or [])}}
    if not tags: return dict(out, result="error", why="The file can't be read")
    label, notes = clean_label(tags, rel)
    if not label["title"]: return dict(out, result="skipped", why="No title in the tags or the file name")
    new, how, cover, flagged = {}, "", None, ""
    if not quick and label["artists"]:
        fps = {}
        res = verify_file(p, label, tags["duration"], fps=fps)
        if res["status"] not in ("ok", "tags_wrong"):
            res = _identify_audio(p, rel, label, tags["duration"], fps, res) or res
        ref = res.get("ref") or {}
        if res["status"] in ("ok", "tags_wrong") and ref.get("id"):
            meta = reference_metadata(ref)
            if meta.get("title"):
                new = {"title": _prefer_title(label["title"], meta["title"]), "artists": _prefer_artists(label["artists"], meta.get("artists") or [])}
                for k in ("album", "albumartist", "date", "tracknumber", "discnumber", "isrc", "genre"):
                    if not tags.get(k) and meta.get(k): new[k] = meta[k]
                if str(new.get("discnumber") or "") in ("0", "1"): new.pop("discnumber", None)     # "disc 1 of 1" says nothing
                how = f"matched {ref.get('artist')} - {ref.get('title')} on {str(ref.get('source') or 'the catalog').title()} by fingerprint"
                if not tags["has_cover"] and meta.get("cover_url"): cover = fetch_bytes(meta["cover_url"])
                st = p.stat()
                audit_put(rel, dict(res, status="ok", mtime=st.st_mtime, size=st.st_size, checked_at=time.time(), duration=round(tags["duration"], 1),
                                    label={"title": new["title"], "artist": ", ".join(new["artists"]), "album": new.get("album") or tags.get("album"), "isrc": new.get("isrc") or tags.get("isrc")}))
        elif res["status"] == "mismatch":
            flagged = res.get("reason") or "The audio isn't the song its tags name"
    if not new and notes:
        new = {"title": label["title"]}
        if not tags.get("artists") and label["artists"]: new["artists"] = label["artists"]
        if not tags.get("album") and label.get("album"): new["album"] = label["album"]
        how = "cleaned up (" + ", ".join(notes) + ")" + ("" if quick else ", not confirmed by the catalog")
    changes = {k: v for k, v in new.items() if _tag_value(v) != _tag_value(tags.get(k)) and _tag_value(v)}
    if not changes and not cover:
        with library_cache_lock: shown = dict(library_cache_data.get(rel) or {})
        refresh_library_entry(rel)
        with library_cache_lock: now = dict(library_cache_data.get(rel) or {})
        if any(shown.get(k) != now.get(k) for k in ("title", "artist", "album")):
            return dict(out, before={"title": shown.get("title") or "", "artist": shown.get("artist") or ""},
                        after={"title": now.get("title") or "", "artist": now.get("artist") or ""}, result="refreshed",
                        how="the library was showing out-of-date details; the file's own tags were right" + (f". {flagged}" if flagged else ""))
        return dict(out, result="flagged" if flagged else "ok", why=flagged or "Already right")
    before = {k: tags.get(k) for k in changes}
    write_track_tags(p, changes, cover=cover, replace_cover=False)
    refresh_library_entry(rel)
    fid = _record_fix(rel, before, changes, how, bool(cover))
    after = {"title": changes.get("title", tags.get("title") or ""), "artist": ", ".join(changes.get("artists") or tags.get("artists") or [])}
    return dict(out, result="fixed" if "fingerprint" in how else "cleaned", id=fid, after=after, how=how, changed=sorted(changes) + (["cover"] if cover else []),
                why=flagged)

def undo_fix(fid):
    """Put back the tags a fix changed. (A cover it added stays.)"""
    with _history_lock:
        hist = _load_json_file(TAGFIX_HISTORY, [])
        item = next((h for h in hist if h.get("id") == fid), None)
    if not item: raise ValueError("That change isn't in the history any more.")
    p = Path(get_real_music_dir()) / item["rel"]
    if not p.is_file(): raise ValueError("The file isn't there any more.")
    before = item.get("before") or {}
    write_track_tags(p, {k: v for k, v in before.items() if _tag_value(v)}, clear=[k for k, v in before.items() if not _tag_value(v)])
    refresh_library_entry(item["rel"])
    with _history_lock:
        hist = [h for h in _load_json_file(TAGFIX_HISTORY, []) if h.get("id") != fid]
        _save_json_file(TAGFIX_HISTORY, hist)
    with tagfix_lock:
        for r in tagfix_state["results"]:
            if r.get("id") == fid: r.update(result="undone")
    return item["rel"]

def _tagfix_log(msg):
    tagfix_state["logs"].append(msg)

def _run_tagfix(rels, quick):
    counts = collections.Counter()
    it, it_lock = iter(sorted(rels, key=str.lower)), threading.Lock()

    def worker():
        while not tagfix_stop.is_set():
            with it_lock: rel = next(it, None)
            if rel is None: return
            try: r = fix_track(rel, quick=quick)
            except Exception as ex:
                r = {"rel": rel, "result": "error", "why": str(ex)[:200]}
            with tagfix_lock:
                counts[r["result"]] += 1
                tagfix_state["scanned"] += 1
                tagfix_state["changed"] = counts["fixed"] + counts["cleaned"] + counts["refreshed"]
                if r["result"] != "ok": tagfix_state["results"].insert(0, r)
                del tagfix_state["results"][2000:]
            if r["result"] in ("fixed", "cleaned", "refreshed"):
                b, a = r["before"], r["after"]
                what = []
                if a["title"] != b["title"]: what.append(f"'{b['title']}' → '{a['title']}'")
                if a["artist"] != b["artist"]: what.append(f"by {a['artist']}")
                filled = [k for k in r.get("changed") or [] if k not in ("title", "artists")]
                if filled: what.append("filled " + ", ".join(filled))
                _tagfix_log(f"[{ {'fixed': 'FIXED', 'cleaned': 'CLEANED', 'refreshed': 'RE-READ'}[r['result']] }] {rel}: {' · '.join(what) or 'updated'} ({r['how']})")
            elif r["result"] in ("flagged", "error", "skipped"):
                _tagfix_log(f"[{r['result'].upper()}] {rel}: {r.get('why')}")

    try:
        threads = [threading.Thread(target=worker, daemon=True) for _ in range(1 if quick else 2)]
        for t in threads: t.start()
        for t in threads: t.join()
        audit_flush()
        if counts["fixed"] or counts["cleaned"] or counts["refreshed"]: rebuild_in_memory_tree()
    except Exception as ex:
        _tagfix_log(f"[ERR] {ex}")
    with tagfix_lock: tagfix_state["status"] = "stopped" if tagfix_stop.is_set() else "completed"
    _tagfix_log(f"[FINISH] {tagfix_state['scanned']}/{len(rels)} checked · confirmed and fixed {counts['fixed']} · cleaned up {counts['cleaned']} · re-read {counts['refreshed']} · "
                f"already right {counts['ok']} · flagged {counts['flagged']} · skipped {counts['skipped']} · errors {counts['error']}")

@app.route("/api/admin/tagfix/start", methods=["POST"])
def api_admin_tagfix_start():
    d = _json()
    rels = scope_rels(d)
    if not rels: return jsonify({"error": "There are no songs there."}), 400
    with tagfix_lock:
        if tagfix_state["status"] == "running": return jsonify({"error": "The tag fixer is already running."}), 409
        tagfix_stop.clear()
        tagfix_state.update(status="running", total=len(rels), scanned=0, changed=0, results=[], scope=scope_text(d), quick=bool(d.get("quick")), started_at=time.time())
        tagfix_state["logs"].clear()
    _tagfix_log(f"[INIT] Fixing titles and tags of {len(rels)} song{'s' if len(rels) != 1 else ''} in {scope_text(d)}"
                + (" (cleanup only)." if d.get("quick") else ". Each song is looked up and confirmed by its fingerprint."))
    activity("library", f"Started fixing titles and tags in {scope_text(d)}", admin_name())
    threading.Thread(target=_run_tagfix, args=(rels, bool(d.get("quick"))), daemon=True, name="tagfix").start()
    return jsonify({"ok": True, "total": len(rels)})

@app.route("/api/admin/tagfix/stop", methods=["POST"])
def api_admin_tagfix_stop():
    tagfix_stop.set()
    return jsonify({"ok": True})

@app.route("/api/admin/tagfix/status")
def api_admin_tagfix_status():
    with tagfix_lock:
        return jsonify({k: (list(v) if k == "logs" else v[:300] if k == "results" else v) for k, v in tagfix_state.items()})

@app.route("/api/admin/tagfix/undo", methods=["POST"])
def api_admin_tagfix_undo():
    d = _json()
    with tagfix_lock:
        ids = [r["id"] for r in tagfix_state["results"] if r.get("id") and r["result"] in ("fixed", "cleaned")] if d.get("all") else [str(d.get("id") or "")]
    done, errors = 0, []
    for fid in ids:
        try:
            undo_fix(fid)
            done += 1
        except ValueError as ex: errors.append(str(ex))
    if done: rebuild_in_memory_tree()
    if not done and errors: return jsonify({"error": errors[0]}), 400
    return jsonify({"ok": True, "undone": done})


# --- DUPLICATES ---
# Two files are the same song only when the audio says so: the same title and an artist in common (once cleaned up, as
# the tag fixer does), the same length within 3 seconds, no sign that one is another edit (clean, radio edit), and
# fingerprints that match closely over the first four minutes, throughout (an instrumental matches on average but not
# where the vocals are). Of each set, the copy with the most complete tags stays; a lossless copy always beats a lossy
# one. It gets whatever tags, cover and lyrics file it was missing from the others, the others go to quarantine (Library
# audit, where they can be restored), and likes, playlists, history and the listening log that pointed at them point at
# the copy that stays. It ends up in its album's folder when one of the copies was there: the album is what most of that
# folder's songs are tagged with, so an album copy tagged as the single still counts. A song that joins its album that
# way takes the album's tags, its number on the album and the album's cover.
DUP_IGNORE = CONFIG_DIR / "duplicates_ignored.json"
DUP_REPAIR_MARK = CONFIG_DIR / "duplicates_repair_v1"
DUP_BER, DUP_WORST, DUP_SECONDS, DUP_FP_SECONDS = 0.10, 0.15, 3.0, 240
_SINGLE_RE = re.compile(r"(?i)\s*(?:[-\u2013]\s*single|[\(\[]single[\)\]])\s*$")
_EDITION_RE = re.compile(r"(?i)\s*[\(\[][^\)\]]*\b(?:deluxe|remaster(?:ed)?|edition|expanded|anniversary|bonus|explicit|clean)\b[^\)\]]*[\)\]]")
dup_resolve_lock = threading.Lock()
_EDIT_RE = re.compile(r"(?i)\b(?:clean|radio\s+edit|censored|explicit|edited)\b")
dup_state = {"status": "idle", "logs": collections.deque(maxlen=800), "total": 0, "scanned": 0, "groups": [], "scope": "",
             "auto": False, "started_at": 0, "removed": 0}
dup_lock = threading.RLock()
dup_stop = threading.Event()

def _dup_log(msg):
    dup_state["logs"].append(msg)

def _dup_label(rel, e):
    """(title key, version markers, artist keys) of a library entry, cleaned up like the tag fixer would."""
    artist = e.get("artist") if e.get("artist") and e.get("artist") != "Unknown Artist" else ""
    label, _ = clean_label({"title": e.get("title") or "", "artists": [artist] if artist else [], "albumartist": e.get("album_artist") or "",
                            "tracknumber": str(e.get("track_number") or "")}, rel)
    tk, marks = title_key(label["title"])
    return tk, marks, artist_keys(label["artists"])

def _is_lossless(p):
    ext = p.suffix.lower()
    if ext in (".flac", ".wav", ".aif", ".aiff"): return True
    if ext in (".m4a", ".mp4"):
        try:
            from mutagen import File as MFile
            return "alac" in str(getattr(MFile(str(p)).info, "codec", "")).lower()
        except Exception: return False
    return False

def _bitrate(p):
    try:
        from mutagen import File as MFile
        return int((getattr(MFile(str(p)).info, "bitrate", 0) or 0) / 1000)
    except Exception: return 0

def _cover_data(p):
    """The embedded front cover's bytes, or None."""
    try:
        from mutagen import File as MFile
        f = MFile(str(p))
        if getattr(f, "pictures", None): return f.pictures[0].data
        tags = getattr(f, "tags", None) or {}
        for k in list(tags.keys()):
            if str(k).startswith("APIC"): return tags[k].data
        if "covr" in tags and tags["covr"]: return bytes(tags["covr"][0])
    except Exception: pass
    return None

def _copy_facts(rel):
    """What one copy has going for it: format, bitrate and how complete its tags are."""
    p = Path(get_real_music_dir()) / rel
    tags = read_track_tags(p) or {}
    _, notes = clean_label(tags, rel)
    have = [k for k in ("title", "artists", "album", "albumartist", "date", "tracknumber", "isrc", "genre") if tags.get(k)]
    lrc = p.with_suffix(".lrc").is_file()
    score = len(have) + (2 if tags.get("has_cover") else 0) + (1 if (tags.get("cover_bytes") or 0) >= 40 * 1024 else 0) \
        + (0 if notes else 1) + (1 if lrc else 0)
    missing = [k for k in ("title", "artists", "album", "tracknumber", "date", "isrc") if not tags.get(k)] + ([] if tags.get("has_cover") else ["cover"])
    return {"rel": rel, "format": p.suffix.lstrip(".").upper(), "lossless": _is_lossless(p), "bitrate": _bitrate(p), "score": score,
            "missing": missing, "lyrics": lrc, "duration": round(tags.get("duration") or 0, 1), "tags": tags,
            "title": tags.get("title") or "", "artist": ", ".join(tags.get("artists") or []), "album": tags.get("album") or ""}

def _keeper(copies):
    """The copy to keep: lossless first, then the most complete tags, the higher bitrate, and a copy in an album folder."""
    def in_album(c):
        a = c["tags"].get("album") or ""
        return bool(a) and _norm(Path(c["rel"]).parent.name) == _norm(a)
    return max(copies, key=lambda c: (c["lossless"], c["score"], c["bitrate"], in_album(c), -len(c["rel"])))

def _album_base(name):
    """An album or folder name for comparing the two: without ' - Single' / ' - EP' or an edition ('(Deluxe)')."""
    return _norm(_EDITION_RE.sub("", re.sub(r"(?i)\s*[-\u2013]\s*(?:single|ep)\s*$", "", name or "")))

def _single_like(album, title):
    """Tagged as a single: no album, '... - Single', or the album is named after the song."""
    return not album or bool(_SINGLE_RE.search(album)) or _album_base(album) == title_key(title)[0]

def _folder_album(folder):
    """(the album most of a folder's songs are tagged with, how many are, how many songs it has), from the library index."""
    with library_cache_lock:
        albums = [e.get("album") or "" for r, e in library_cache_data.items() if isinstance(e, dict) and str(Path(r).parent) == folder]
    if not albums: return "", 0, 0
    album, n = collections.Counter(albums).most_common(1)[0]
    return album, n, len(albums)

def _home_rank(folder):
    """(rank, album) of a folder as an album's home, or (None, album) when it isn't one: it has to be named after the
    album most of its songs are tagged with. A real album (more than one song, not a single) ranks first, then fuller."""
    album, n, total = _folder_album(folder)
    if folder in ("", ".") or not album or _album_base(Path(folder).name) != _album_base(album): return None, album
    return (not _SINGLE_RE.search(album) and total >= 2, n, total), album

def _album_home(keep, copies):
    """Where the kept copy belongs: (folder to move it to or None, the copy whose place it takes, the album that folder
    holds or None). Of the copies' folders that are an album's home, a real album comes before a single, then the fullest;
    and it has to be an album one of the copies is tagged with, unless they're all tagged as the single (a single that's
    also on its album). Without one, an existing folder of the album the kept copy has, in the artist's folder."""
    here = str(Path(keep["rel"]).parent)
    tagged = {_album_base(c["tags"].get("album")) for c in copies if c["tags"].get("album")}
    singles = all(_single_like(c["tags"].get("album"), c["tags"].get("title") or c["title"]) for c in copies)
    ranked = []
    for c in copies:
        folder = str(Path(c["rel"]).parent)
        rank, album = _home_rank(folder)
        if rank and (_album_base(album) in tagged or (singles and rank[0])): ranked.append((rank, c is keep, c, folder, album))
    if ranked:
        _, _, best, folder, album = max(ranked, key=lambda x: (x[0], x[1]))
        return (None, None, album) if folder == here else (folder, best, album)
    album = keep["tags"].get("album") or next((c["tags"].get("album") for c in copies if c["tags"].get("album")), "")
    if _single_like(album, keep["tags"].get("title") or keep["title"]) or _norm(album) == "singles": return None, None, None
    if _album_base(Path(here).name) == _album_base(album): return None, None, album
    top = keep["rel"].split("/")[0] if "/" in keep["rel"] else ""
    root = Path(get_real_music_dir()) / top
    if top and root.is_dir():
        for sub in root.iterdir():
            if sub.is_dir() and _album_base(sub.name) == _album_base(album): return f"{top}/{sub.name}", None, album
    return None, None, None

def _joins_album(tags, album, place_tags):
    """Whether a song in `album`'s folder takes that album's tags: it's tagged as the single (or nothing), or the copy
    whose place it took was on that album. A song tagged as some other album is left as it is."""
    if not album or _album_base(tags.get("album")) == _album_base(album): return False
    return bool(place_tags) and _album_base(place_tags.get("album")) == _album_base(album) or _single_like(tags.get("album"), tags.get("title"))

def _album_track_number(artist, album, title):
    """(track, disc) of a song on an album, from the album's track list on Deezer, or (None, None)."""
    try:
        for a in (http_json("https://api.deezer.com/search/album?limit=10&q=" + urllib.parse.quote(f"{artist} {album}")) or {}).get("data") or []:
            if _album_base(a.get("title")) != _album_base(album) or not artist_keys([artist]) & artist_keys([(a.get("artist") or {}).get("name") or ""]):
                continue
            for t in (http_json(f"https://api.deezer.com/album/{a['id']}/tracks?limit=300") or {}).get("data") or []:
                if t.get("track_position") and title_match(title, t.get("title") or "")[0]:
                    return int(t["track_position"]), int(t.get("disk_number") or 1)
    except Exception: pass
    return None, None

def _fit_album(rel, album, place_tags=None):
    """The kept copy is in `album`'s folder. If it's tagged as the single, it takes the album's name, artist, date and
    cover, and its number on the album: the number of the copy it replaced when that one was on the album, otherwise
    Deezer's, otherwise the replaced copy's when no other song of the album has it. Returns the album, or None."""
    music = Path(get_real_music_dir())
    p = music / rel
    tags = read_track_tags(p) or {}
    if not _joins_album(tags, album, place_tags): return None
    place_fits = bool(place_tags) and _album_base(place_tags.get("album")) == _album_base(album)
    folder = str(Path(rel).parent)
    with library_cache_lock:
        sibs = [(r, dict(e)) for r, e in library_cache_data.items() if isinstance(e, dict) and r != rel and str(Path(r).parent) == folder
                and _album_base(e.get("album")) == _album_base(album)]
    ref = next((music / r for r, _ in sibs if (music / r).is_file()), None)
    rt = (read_track_tags(ref) or {}) if ref else {}
    src = place_tags if place_fits else rt
    num = lambda v: str(v or "").split("/")[0].strip().lstrip("0")
    used = {num(e.get("track_number")) for _, e in sibs} - {""}
    theirs = num((place_tags or {}).get("tracknumber"))
    track, disc = (theirs, (place_tags or {}).get("discnumber")) if place_fits and theirs else (None, None)
    if not track:
        artist = (tags.get("artists") or [tags.get("albumartist") or ""])[0]
        track, disc = _album_track_number(artist, album, tags.get("title") or Path(rel).stem)
        track = num(track)
        if not track or track in used: track, disc = (theirs, None) if theirs and theirs not in used else (None, None)
    meta = {"album": album, "albumartist": src.get("albumartist") or rt.get("albumartist"), "date": src.get("date") or rt.get("date"),
            "tracknumber": track, "discnumber": disc}
    cover = _cover_data(ref) if ref and rt.get("has_cover") else None
    write_track_tags(p, meta, cover=cover, replace_cover=True, clear=() if track else ("tracknumber",))
    return album

def _remove_empty_dirs(rels):
    """Folders these files left completely empty go (anything still in them, even a cover image, keeps them)."""
    music = Path(get_real_music_dir())
    for rel in rels:
        d = (music / rel).parent
        while d != music and d.is_relative_to(music):
            try: d.rmdir()
            except OSError: break
            d = d.parent

def _dup_proposal(rels):
    copies = [_copy_facts(r) for r in rels if (Path(get_real_music_dir()) / r).is_file()]
    if len(copies) < 2: return None
    keep = _keeper(copies)
    home, place, album = _album_home(keep, copies)
    gid = hashlib.sha1("\n".join(sorted(rels)).encode()).hexdigest()[:12]
    name = (Path(place["rel"]).stem if place else Path(keep["rel"]).stem) + Path(keep["rel"]).suffix
    tags = dict(keep["tags"])
    if not tags.get("album"): tags["album"] = next((c["tags"].get("album") for c in copies if c["tags"].get("album")), "")
    joins = album if _joins_album(tags, album, place["tags"] if place else None) else None
    return {"id": gid, "rels": sorted(rels), "keep": keep["rel"], "move_to": home, "move_as": name if home else None, "joins": joins, "state": "found",
            "copies": [{k: v for k, v in c.items() if k != "tags"} | {"role": "keep" if c is keep else "remove"} for c in copies]}

def resolve_duplicates(group):
    """Keep the best copy of a confirmed set, and quarantine the others. Returns where the kept copy ends up. One set at a
    time: the same set asked for twice at once (a second click, Remove all) would otherwise be quarantined twice."""
    with dup_resolve_lock: return _resolve_duplicates(group)

def _resolve_duplicates(group):
    music = Path(get_real_music_dir())
    copies = [_copy_facts(r) for r in group["rels"] if (music / r).is_file()]
    if len(copies) < 2: raise ValueError("Only one copy is left.")
    keep = _keeper(copies)
    others = sorted([c for c in copies if c is not keep], key=lambda c: -c["score"])
    kp = music / keep["rel"]
    # What the kept copy is missing, from the others: tags, the cover, a lyrics file.
    fill = {}
    for c in others:
        for k in TAGFIX_KEYS:
            if not keep["tags"].get(k) and c["tags"].get(k) and k not in fill: fill[k] = c["tags"][k]
    cover = None
    if not keep["tags"].get("has_cover"):
        cover = next((d for d in (_cover_data(music / c["rel"]) for c in others if c["tags"].get("has_cover")) if d), None)
    if fill or cover: write_track_tags(kp, fill, cover=cover, only_missing=True, replace_cover=False)
    home, place, album = _album_home(keep, copies)
    if not keep["lyrics"]:
        lrc = next((music / c["rel"] for c in others if c["lyrics"]), None)
        if lrc: shutil.copyfile(lrc.with_suffix(".lrc"), kp.with_suffix(".lrc"))
    # The others go to quarantine.
    for c in others:
        quarantine_original(c["rel"], f"Duplicate of {keep['rel']}", {"kind": "duplicate", "kept": keep["rel"]})
        (music / c["rel"]).unlink(missing_ok=True)
        (music / c["rel"]).with_suffix(".lrc").unlink(missing_ok=True)
    forget_library_paths([c["rel"] for c in others], rebuild=False)
    final = keep["rel"]
    if home:
        dest = music / home / ((Path(place["rel"]).stem if place else kp.stem) + kp.suffix)
        n = 2
        while dest.exists():
            dest = music / home / f"{dest.stem.rsplit(' (', 1)[0]} ({n}){kp.suffix}"
            n += 1
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(kp), str(dest))
        if kp.with_suffix(".lrc").is_file(): shutil.move(str(kp.with_suffix(".lrc")), str(dest.with_suffix(".lrc")))
        final = str(dest.relative_to(music))
        move_library_paths(keep["rel"], final)
    remap_song_paths({c["rel"]: final for c in others})
    if album: _fit_album(final, album, place["tags"] if place else None)
    refresh_library_entry(final)
    _remove_empty_dirs([c["rel"] for c in others] + [keep["rel"]])
    save_and_rebuild_cache()
    from flask import has_request_context
    activity("library", f"Removed {len(others)} duplicate{'s' if len(others) != 1 else ''} of {final} (in quarantine)",
             admin_name() if has_request_context() else None)
    return final

def _fp_match(a, b):
    """(average, worst-stretch) bit error of two songs' fingerprints at their best alignment: the worst 10% of 2-second
    stretches, where an instrumental or another take of the song gives itself away."""
    if len(a) > len(b): a, b = b, a
    ber, off = fingerprint_similarity(a, b)
    if ber >= 1.0: return 1.0, 1.0
    o = int(round(off / FP_ITEM_SEC))
    errs = [(a[i] ^ b[i + o]).bit_count() / 32.0 for i in range(max(0, -o), min(len(a), len(b) - o))]
    wins = sorted(sum(errs[i:i + 16]) / 16 for i in range(0, max(1, len(errs) - 15), 4))
    return ber, (wins[int(len(wins) * 0.9)] if wins else ber)

def _ignored_sets():
    return [set(x) for x in _load_json_file(DUP_IGNORE, []) if isinstance(x, list)]

def _run_dups(rels, auto):
    try:
        ignored = _ignored_sets()
        buckets = collections.defaultdict(list)
        with library_cache_lock: entries = {r: dict(library_cache_data.get(r) or {}) for r in rels}
        for rel, e in entries.items():
            tk, marks, akeys = _dup_label(rel, e)
            if tk and akeys: buckets[(tk, marks)].append((rel, akeys))
        cands = [b for b in buckets.values() if len(b) > 1]
        todo = sum(len(b) for b in cands)
        with dup_lock: dup_state.update(total=todo)
        _dup_log(f"[DISCOVERY] {len(cands)} title{'s' if len(cands) != 1 else ''} appear more than once ({todo} files). Each set is checked by fingerprint.")
        fps, durs = {}, {}
        music = Path(get_real_music_dir())

        def fp(rel):
            if rel not in fps:
                p = music / rel
                durs[rel] = (read_track_tags(p) or {}).get("duration") or 0
                fps[rel] = audio_fingerprint(p, max_seconds=DUP_FP_SECONDS)
                with dup_lock: dup_state["scanned"] += 1
            return fps[rel]

        for bucket in cands:
            if dup_stop.is_set(): break
            parent = {r: r for r, _ in bucket}
            def root(x):
                while parent[x] != x: x = parent[x]
                return x
            for i, (a, ak) in enumerate(bucket):
                for b, bk in bucket[i + 1:]:
                    if dup_stop.is_set() or root(a) == root(b) or not (ak & bk): continue
                    if bool(_EDIT_RE.search(a)) != bool(_EDIT_RE.search(b)) or \
                       bool(_EDIT_RE.search(entries[a].get("title") or "")) != bool(_EDIT_RE.search(entries[b].get("title") or "")): continue
                    fa, fb = fp(a), fp(b)
                    if abs(durs[a] - durs[b]) > DUP_SECONDS or len(fa) < 60 or len(fb) < 60: continue
                    ber, worst = _fp_match(fa, fb)
                    if ber <= DUP_BER and worst <= DUP_WORST: parent[root(b)] = root(a)
            sets = collections.defaultdict(list)
            for r, _ in bucket: sets[root(r)].append(r)
            for members in sets.values():
                if len(members) < 2 or any(set(members) <= s for s in ignored): continue
                prop = _dup_proposal(members)
                if not prop: continue
                if auto: prop["state"] = "removing"
                with dup_lock: dup_state["groups"].append(prop)
                _dup_log(f"[FOUND] {len(members)} copies of '{prop['copies'][0]['title'] or Path(members[0]).stem}': keeping {prop['keep']}"
                         + (f", moving it to {prop['move_to']}/" if prop["move_to"] else "") + (f", as part of {prop['joins']}" if prop["joins"] else ""))
                if auto:
                    try:
                        final = resolve_duplicates(prop)
                        prop.update(state="resolved", final=final)
                        with dup_lock: dup_state["removed"] += len(members) - 1
                        _dup_log(f"[FIXED] Kept {final}; the other{'s' if len(members) > 2 else ''} went to quarantine")
                    except Exception as ex:
                        prop.update(state="error", error=str(ex)[:200])
                        _dup_log(f"[ERR] {ex}")
        with dup_lock: dup_state["status"] = "stopped" if dup_stop.is_set() else "completed"
        n = len(dup_state["groups"])
        _dup_log(f"[FINISH] {n} set{'s' if n != 1 else ''} of duplicates" + (f" · {dup_state['removed']} removed" if dup_state["removed"] else ""))
    except Exception as ex:
        with dup_lock: dup_state["status"] = "error"
        _dup_log(f"[ERR] {ex}")
        _dup_log(traceback.format_exc())

def repair_duplicate_homes():
    """Axdio 2.10.0 could keep a song in its single's folder when the copy it removed was in the album's folder but tagged
    as the single. Once, after a scan: each such song moves into the album's folder, in the removed copy's place, and takes
    the album's tags. What was removed stays in quarantine. Returns where the songs went."""
    music = Path(get_real_music_dir())
    with quarantine_lock: idx = [i for i in _load_json_file(QUARANTINE_INDEX, []) if i.get("kind") == "duplicate"]
    seen, moved = set(), []
    for item in sorted(idx, key=lambda i: i.get("at") or 0):
        kept, gone = item.get("kept") or "", item.get("rel_path") or ""
        if not kept or not gone or (kept, gone) in seen: continue
        seen.add((kept, gone))
        kp, folder, here = music / kept, str(Path(gone).parent), str(Path(kept).parent)
        if folder == here or not kp.is_file() or not (music / folder).is_dir(): continue
        (rank, album), (mine, _) = _home_rank(folder), _home_rank(here)
        if not rank or not rank[0] or (mine and mine >= rank): continue
        try: gtags = read_track_tags(Path(item.get("file") or "")) or {}
        except Exception: gtags = {}
        ktags = read_track_tags(kp) or {}
        if not (_album_base(gtags.get("album")) == _album_base(album) or
                (_single_like(gtags.get("album"), gtags.get("title")) and _single_like(ktags.get("album"), ktags.get("title")))): continue
        dest = music / folder / (Path(gone).stem + kp.suffix)
        if dest.exists(): continue
        try:
            shutil.move(str(kp), str(dest))
            if kp.with_suffix(".lrc").is_file(): shutil.move(str(kp.with_suffix(".lrc")), str(dest.with_suffix(".lrc")))
            final = str(dest.relative_to(music))
            move_library_paths(kept, final)
            _fit_album(final, album, gtags)
            refresh_library_entry(final)
            _remove_empty_dirs([kept])
            moved.append(final)
            activity("library", f"Moved {final} into its album (a duplicate removed by 2.10.0 was the album's copy)")
        except Exception as ex:
            print(f"[WARN] Couldn't move {kept} into its album: {ex}")
    if moved:
        save_and_rebuild_cache()
        print(f"[INFO] Duplicates: moved {len(moved)} song(s) into their albums: {', '.join(moved)}")
    DUP_REPAIR_MARK.touch()
    return moved

@app.route("/api/admin/dups/start", methods=["POST"])
def api_admin_dups_start():
    d = _json()
    rels = scope_rels(d)
    if not rels: return jsonify({"error": "There are no songs there."}), 400
    with dup_lock:
        if dup_state["status"] == "running": return jsonify({"error": "The duplicate finder is already running."}), 409
        dup_stop.clear()
        dup_state.update(status="running", total=0, scanned=0, groups=[], removed=0, scope=scope_text(d), auto=bool(d.get("auto")), started_at=time.time())
        dup_state["logs"].clear()
    _dup_log(f"[INIT] Looking for duplicates among {len(rels)} songs in {scope_text(d)}"
             + (". Confirmed duplicates are removed as they're found." if d.get("auto") else ". Nothing is removed until you say so."))
    threading.Thread(target=_run_dups, args=(rels, bool(d.get("auto"))), daemon=True, name="duplicates").start()
    return jsonify({"ok": True, "songs": len(rels)})

@app.route("/api/admin/dups/stop", methods=["POST"])
def api_admin_dups_stop():
    dup_stop.set()
    return jsonify({"ok": True})

@app.route("/api/admin/dups/status")
def api_admin_dups_status():
    with dup_lock: return jsonify({k: (list(v) if k == "logs" else v) for k, v in dup_state.items()})

@app.route("/api/admin/dups/resolve", methods=["POST"])
def api_admin_dups_resolve():
    d = _json()
    with dup_lock:
        todo = [g for g in dup_state["groups"] if g["state"] == "found" and (d.get("all") or g["id"] == d.get("id"))]
        for g in todo: g["state"] = "removing"
    if not todo: return jsonify({"error": "There's nothing to remove there."}), 404
    done, errors = 0, []
    for g in todo:
        try:
            final = resolve_duplicates(g)
            g.update(state="resolved", final=final)
            done += len(g["rels"]) - 1
        except Exception as ex:
            g.update(state="error", error=str(ex)[:200])
            errors.append(str(ex))
    with dup_lock: dup_state["removed"] += done
    if not done and errors: return jsonify({"error": errors[0]}), 400
    return jsonify({"ok": True, "removed": done})

@app.route("/api/admin/dups/ignore", methods=["POST"])
def api_admin_dups_ignore():
    """'These aren't duplicates': the set is left out of later searches."""
    d = _json()
    with dup_lock: g = next((g for g in dup_state["groups"] if g["id"] == d.get("id")), None)
    if not g: return jsonify({"error": "That set isn't in the results any more."}), 404
    sets = _load_json_file(DUP_IGNORE, [])
    sets.append(g["rels"])
    _save_json_file(DUP_IGNORE, sets[-5000:])
    g["state"] = "ignored"
    return jsonify({"ok": True})


def library_copies(target):
    """Library files that are (or claim to be) this song: same title, and an artist in common."""
    tkey = title_key(target["title"])
    if not tkey[0] or not target.get("artists"): return []
    with library_cache_lock:
        found = [(rel, dict(v)) for rel, v in library_cache_data.items()
                 if isinstance(v, dict) and not rel.startswith("@") and title_key(v.get("title")) == tkey]
    out, missing = [], []
    for rel, v in found:
        if not (Path(get_real_music_dir()) / rel).is_file():
            missing.append(rel)                                  # deleted outside Axdio: not a copy, and not in the library
            continue
        # Same artists too ('Levitating (feat. DaBaby)' isn't a copy of 'Levitating'), from the file's own tags:
        # the library index keeps only the first artist.
        tags = read_track_tags(Path(get_real_music_dir()) / rel) or {}
        credits = tags.get("artists") or [v.get("artist")]
        title = tags.get("title") or v.get("title")
        if same_credits(target["artists"], target["title"], ", ".join(a for a in credits if a), title) or \
           (v.get("album_artist") and same_credits(target["artists"], target["title"], v["album_artist"], title) and len(credits) <= 1):
            out.append(rel)
    if missing: forget_library_paths(missing)
    return out


def _find_in_library(artists, title):
    """rel_path of a library track with this artist and title, whatever its file happens to be named."""
    found = library_copies({"title": title, "artists": artists})
    return found[0] if found else None
























































# --- LYRICS SCANNER ---
def _run_lyrics_task(music_dir):
    global admin_lyrics_state
    with lyrics_lock:
        admin_lyrics_state["status"] = "scraping"
        admin_lyrics_state["logs"].clear()
        admin_lyrics_state["fetched"] = 0
        admin_lyrics_state["scanned"] = 0

    admin_lyrics_state["logs"].append("[INIT] Synchronized lyrics scanner started.")
    items = []
    cdata = globals().get("library_cache_data")
    if isinstance(cdata, dict) and len(cdata) > 0:
        admin_lyrics_state["logs"].append(f"[CACHE] Reading {len(cdata)} indexed tracks from memory cache...")
        for rel_p, meta in cdata.items():
            fp = os.path.join(music_dir, rel_p)
            if os.path.isfile(fp):
                items.append((fp, meta.get("artist") or "", meta.get("title") or "", os.path.basename(fp)))
    else:
        admin_lyrics_state["logs"].append(f"[SCAN] Indexing library directory: {music_dir}...")
        for root, _, files in os.walk(music_dir):
            for f in files:
                if f.lower().endswith((".flac", ".mp3", ".m4a")):
                    items.append((os.path.join(root, f), "", "", f))

    admin_lyrics_state["total"] = len(items)
    admin_lyrics_state["logs"].append(f"[AUDIT] Scanning {len(items)} tracks for missing .lrc files...")
    fetched = 0
    skipped = 0

    for idx, (fp, c_art, c_tit, fname) in enumerate(items, 1):
        admin_lyrics_state["scanned"] = idx
        lrc_path = os.path.splitext(fp)[0] + ".lrc"
        if os.path.exists(lrc_path) and os.path.getsize(lrc_path) > 32:
            skipped += 1
            continue

        artist = c_art
        title = c_tit
        if not artist or not title:
            base = os.path.splitext(fname)[0]
            if " - " in base: artist, title = base.split(" - ", 1)
            else: artist, title = "", base

        artist = re.sub(r"\s*-\s*Topic$", "", str(artist)).strip()
        title = re.sub(r"(?i)\s*[\[\(](official.*?|lyrics?|audio)[\]\)]", "", str(title)).strip()

        admin_lyrics_state["logs"].append(f"[{idx}/{len(items)}] Querying LRCLIB: {artist} - {title}")
        try:
            q = urllib.parse.urlencode({"artist_name": artist, "track_name": title})
            req = urllib.request.Request(f"https://lrclib.net/api/get?{q}", headers={"User-Agent": "Axdio-Music/2.4"})
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                synced = data.get("syncedLyrics") or data.get("plainLyrics")
                if synced:
                    with open(lrc_path, "w", encoding="utf-8") as lf: lf.write(synced)
                    fetched += 1
                    admin_lyrics_state["fetched"] = fetched
                    admin_lyrics_state["logs"].append(f"  --> [SAVED] Synced .lrc: {fname}")
                else:
                    admin_lyrics_state["logs"].append(f"  --> [MISS] No synced lyrics on LRCLIB.")
        except urllib.error.HTTPError as he:
            if he.code == 404: admin_lyrics_state["logs"].append(f"  --> [MISS] Not on LRCLIB: {fname}")
            else: admin_lyrics_state["logs"].append(f"  --> [ERR] LRCLIB HTTP {he.code}")
        except Exception as e:
            admin_lyrics_state["logs"].append(f"  --> [ERR] {e}")
        time.sleep(0.12)

    with lyrics_lock:
        admin_lyrics_state["status"] = "completed"
        admin_lyrics_state["logs"].append(f"[FINISH] Lyrics scan complete: {fetched} saved, {skipped} already present.")

# ============================================================
# DATA SAVER STREAMING (on-the-fly MP3)
# ============================================================
# Lossless files are re-encoded to 48 kHz constant-bitrate MP3. At 48 kHz every frame is exactly
# 3 x kbps bytes and an encode of N samples always makes floor(N / 1152) + 2 frames, so the final
# size is known before encoding finishes. That lets the first play announce a Content-Length and
# answer Range requests (seeking) while ffmpeg is still running. Finished files are cached.
QUALITY_KBPS = {"high": 320, "normal": 192, "low": 128}
TRANSCODE_DIR = CONFIG_DIR / "transcodes"
MAX_TRANSCODES = max(1, min(4, (os.cpu_count() or 2) // 2))
_tc_jobs = {}
_tc_lock = threading.Lock()
_silent_frames = {}

def _source_samples48(path):
    """Sample count after resampling to 48 kHz (exact for FLAC, from the reported length otherwise)."""
    try:
        if path.suffix.lower() == ".flac":
            with open(path, "rb") as f: head = f.read(42)
            if head[:4] == b"fLaC":
                si = head[8:42]
                rate = (si[10] << 12) | (si[11] << 4) | (si[12] >> 4)
                total = ((si[13] & 0x0F) << 32) | (si[14] << 24) | (si[15] << 16) | (si[16] << 8) | si[17]
                if rate and total: return round(total * 48000 / rate)
        import mutagen
        a = mutagen.File(str(path))
        if a is not None and a.info and a.info.length: return round(a.info.length * 48000)
    except Exception: pass
    return None

def _silent_frame(kbps):
    if kbps not in _silent_frames:
        fb = 3 * kbps
        try:
            out = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", "1",
                                  "-c:a", "libmp3lame", "-b:a", f"{kbps}k", "-write_xing", "0", "-id3v2_version", "0", "-f", "mp3", "-"],
                                 capture_output=True, timeout=30).stdout
        except Exception: out = b""
        _silent_frames[kbps] = out[10 * fb:11 * fb] if len(out) >= 11 * fb else b"\x00" * fb
    return _silent_frames[kbps]

class TranscodeJob:
    def __init__(self, key, src, kbps):
        self.key, self.src, self.kbps = key, src, kbps
        self.dest = TRANSCODE_DIR / f"{key}.mp3"
        self.part = TRANSCODE_DIR / f"{key}.part"
        samples = _source_samples48(src)
        self.size = ((samples // 1152) + 2) * 3 * kbps if samples else None
        self.written, self.done, self.failed = 0, False, False
        self.cond = threading.Condition()
        TRANSCODE_DIR.mkdir(parents=True, exist_ok=True)
        self.proc = subprocess.Popen(["ffmpeg", "-nostdin", "-v", "error", "-i", str(src), "-map", "0:a:0", "-vn", "-ac", "2", "-ar", "48000",
                                      "-c:a", "libmp3lame", "-b:a", f"{kbps}k", "-write_xing", "0", "-id3v2_version", "0", "-f", "mp3", "pipe:1"],
                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        threading.Thread(target=self._pump, daemon=True, name="transcode").start()

    def _advance(self, n):
        with self.cond:
            self.written += n
            self.cond.notify_all()

    def _pump(self):
        try:
            with open(self.part, "wb") as out:
                while True:
                    chunk = self.proc.stdout.read(65536)
                    if not chunk: break
                    if self.size is not None: chunk = chunk[:max(0, self.size - self.written)]   # never exceed the promised size
                    if chunk:
                        out.write(chunk); out.flush()
                        self._advance(len(chunk))
                self.proc.stdout.close()
                if self.proc.wait() != 0 and self.written == 0: raise RuntimeError("ffmpeg failed")
                if self.size is not None:
                    frame = _silent_frame(self.kbps)
                    while self.written < self.size:   # a few frames short: finish with silence
                        pad = frame[:self.size - self.written]
                        out.write(pad); out.flush()
                        self._advance(len(pad))
            os.replace(self.part, self.dest)
            self.done = True
        except Exception as ex:
            print(f"[WARN] Data saver encode failed for {self.src.name}: {ex}")
            self.failed = True
            try: self.proc.kill()
            except Exception: pass
            self.part.unlink(missing_ok=True)
        finally:
            with self.cond: self.cond.notify_all()
            with _tc_lock: _tc_jobs.pop(self.key, None)
            _prune_transcodes()

def _prune_transcodes():
    try:
        cap = int(cfg().get("transcode_cache_mb") or 2048) * 1024 * 1024
        files = sorted(TRANSCODE_DIR.glob("*.mp3"), key=lambda p: p.stat().st_mtime)
        total = sum(p.stat().st_size for p in files)
        while files and total > cap:
            old = files.pop(0)
            total -= old.stat().st_size
            old.unlink(missing_ok=True)
    except Exception as ex:
        print(f"[WARN] Pruning the data saver cache failed: {ex}")

def serve_transcoded(file_path, rel_path, kbps):
    st = file_path.stat()
    key = hashlib.md5(f"{rel_path}|{st.st_mtime}|{kbps}".encode()).hexdigest()
    dest = TRANSCODE_DIR / f"{key}.mp3"
    if dest.exists():
        try: os.utime(dest)   # keeps recently played songs in the cache
        except OSError: pass
        resp = send_file(str(dest), mimetype="audio/mpeg", conditional=True)
        resp.headers["Accept-Ranges"] = "bytes"
        return resp
    with _tc_lock:
        job = _tc_jobs.get(key)
        if job is None:
            if len(_tc_jobs) >= MAX_TRANSCODES: return None   # busy: send the original file instead
            try: job = _tc_jobs[key] = TranscodeJob(key, file_path, kbps)
            except Exception as ex:
                print(f"[WARN] Couldn't start ffmpeg: {ex}")
                return None
            if job.size: note_duration(rel_path, (job.size // (3 * kbps) - 2) * 1152 / 48000)
    size = job.size
    start, end = 0, (size - 1 if size else None)
    rng = request.headers.get("Range")
    m = re.match(r"bytes=(\d*)-(\d*)$", rng or "")
    if m and size:
        if m.group(1): start = int(m.group(1)); end = int(m.group(2)) if m.group(2) else size - 1
        elif m.group(2): start = max(0, size - int(m.group(2)))
        end = min(end, size - 1)
        if start > end: return Response(status=416, headers={"Content-Range": f"bytes */{size}"})

    def body():
        f = None
        try:
            pos = start
            while end is None or pos <= end:
                with job.cond:
                    waited = 0
                    while job.written <= pos and not job.done and not job.failed and waited < 120:
                        job.cond.wait(timeout=1); waited += 1
                    avail = job.written
                if avail <= pos: return   # encode finished short, failed or stalled
                if f is None:
                    f = open(job.part if job.part.exists() else dest, "rb")
                    f.seek(pos)
                want = avail - pos if end is None else min(avail, end + 1) - pos
                data = f.read(min(want, 65536))
                if not data:
                    time.sleep(0.05); continue
                pos += len(data)
                yield data
        finally:
            if f: f.close()

    headers = {"Accept-Ranges": "bytes", "Cache-Control": "no-store"}
    if size:
        headers["Content-Length"] = str(end - start + 1)
        if rng: headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    return Response(body(), 206 if (rng and size) else 200, mimetype="audio/mpeg", headers=headers, direct_passthrough=True)

# --- NOW PLAYING & LISTENER MONITOR (WITH PREFETCH GUARD) ---
# Who is streaming right now, by client address (shown on the admin overview).
listeners = {}
listeners_lock = threading.Lock()

@app.route("/api/player/now_playing", methods=["POST"])
def api_player_now_playing():
    data = request.get_json(silent=True) or {}
    ip = client_ip()
    ua = str(request.headers.get("User-Agent", "Browser"))
    agent = "Mobile App" if any(m in ua for m in ["Mobile", "Android", "iPhone", "iPad"]) else "Web Browser"
    src = data.get("src") or ""
    rel = urllib.parse.unquote(src.split("path=")[-1].split("&")[0]) if "path=" in src else ""
    track = os.path.basename(data.get("title") or data.get("track") or rel or urllib.parse.unquote(src))
    status = data.get("status", "STREAMING")
    with listeners_lock:
        listeners[ip] = {"ip": ip, "ua": agent, "last_seen": time.time(), "path": track or "Active Audio Stream",
                         "status": status, "is_playing": status == "STREAMING"}
    user = get_current_user()
    if user and rel and status == "STREAMING": scrobble_now_playing(user, rel)
    if user and (rel or status != "STREAMING"): note_presence(user, rel, status == "STREAMING", data.get("pos"))
    return jsonify({"ok": True})

@app.before_request
def monitor_active_listeners():
    try:
        from flask import request
        p = request.path
        if any(p.startswith(x) for x in ["/api/stream", "/api/devices", "/api/lyrics", "/stream", "/music"]):
            raw_ip = request.headers.get("X-Forwarded-For") or request.remote_addr or "127.0.0.1"
            client_ip = str(raw_ip).split(",")[0].strip()
            ua = str(request.headers.get("User-Agent", "Browser"))
            agent = "Mobile App" if any(m in ua for m in ["Mobile", "Android", "iPhone", "iPad"]) else "Web Browser"
            now = time.time()

            with listeners_lock:
                prev = listeners.get(client_ip, {})
                # PREFETCH GUARD: If the player recently reported the song explicitly (<60s ago),
                # do NOT overwrite it with a browser preload request for the next track!
                if prev.get("is_playing") and (now - prev.get("last_seen", 0) < 60):
                    prev["last_seen"] = now
                    return

                track = request.args.get("path") or request.args.get("title") or ""
                if not track and request.is_json:
                    j = request.get_json(silent=True) or {}
                    track = j.get("title") or j.get("track") or ""
                if track: track = os.path.basename(urllib.parse.unquote(str(track)))

                listeners[client_ip] = {
                    "ip": client_ip,
                    "ua": agent,
                    "last_seen": now,
                    "path": track or prev.get("path", "Active Audio Stream"),
                    "status": "STREAMING",
                    "is_playing": False
                }
    except Exception: pass






# --- LYRICS ENDPOINTS ---
@app.route("/api/admin/scrape_lyrics", methods=["POST"])
def api_admin_scrape_lyrics():
    from flask import jsonify
    with lyrics_lock:
        if admin_lyrics_state["status"] == "scraping": return jsonify({"error": "Lyrics audit already active"}), 409
    music_dir = get_real_music_dir()
    t = threading.Thread(target=_run_lyrics_task, args=(music_dir,), daemon=True)
    t.start()
    return jsonify({"message": "Synced lyrics scraper started in background"})

@app.route("/api/admin/lyrics_status", methods=["GET"])
def api_admin_lyrics_status():
    from flask import jsonify
    return jsonify({
        "status": admin_lyrics_state["status"],
        "fetched": admin_lyrics_state["fetched"],
        "total": admin_lyrics_state["total"],
        "scanned": admin_lyrics_state["scanned"],
        "logs": list(admin_lyrics_state["logs"])
    })

# --- METADATA & ARTWORK FIXER ENDPOINTS ---
@app.route("/api/admin/scrape_art", methods=["POST"])
def api_admin_scrape_art():
    data = request.get_json(silent=True) or {}
    with scrape_lock:
        if admin_scrape_state["status"] == "scraping": return jsonify({"error": "Metadata fixer already running"}), 409
        admin_scrape_state["status"] = "scraping"
    scope = {"paths": [str(x) for x in data.get("paths") or []][:500], "artists": [str(x) for x in data.get("artists") or []][:500]}
    threading.Thread(target=_run_scrape_task, args=(get_real_music_dir(), bool(data.get("force")), scope), daemon=True).start()
    return jsonify({"message": "Metadata fixer started"})

@app.route("/api/admin/scrape_status", methods=["GET"])
def api_admin_scrape_status():
    return jsonify({k: admin_scrape_state[k] for k in ("status", "scraped", "total", "scanned")} | {"logs": list(admin_scrape_state["logs"])})

# --- LIBRARY AUDIT ENDPOINTS ---
@app.route("/api/admin/audit/start", methods=["POST"])
def api_admin_audit_start():
    d = request.get_json(silent=True) or {}
    try: workers = max(1, min(4, int(d.get("workers") or 2)))
    except (TypeError, ValueError): workers = 2
    opts = {"scope": str(d.get("scope") or "")[:200], "recheck": bool(d.get("recheck")), "auto_fix": bool(d.get("auto_fix")), "workers": workers,
            "paths": [str(x) for x in d.get("paths") or []][:500], "artists": [str(x) for x in d.get("artists") or []][:500]}
    with audit_lock:
        if audit_state["status"] == "running": return jsonify({"error": "An audit is already running"}), 409
        audit_state.update(status="running", options=opts)
        audit_state["logs"].clear()
    threading.Thread(target=_run_audit_job, args=(opts,), daemon=True).start()
    return jsonify({"message": "Audit started", "options": opts})

@app.route("/api/admin/audit/stop", methods=["POST"])
def api_admin_audit_stop():
    audit_stop.set()
    with audit_lock: fix_queue.clear()
    audit_log("[STOPPED] Stop requested; finishing the tracks in progress.")
    return jsonify({"message": "Stopping"})

@app.route("/api/admin/audit/status", methods=["GET"])
def api_admin_audit_status():
    with audit_lock:
        totals = collections.Counter(e.get("status", "error") for e in audit_db.values())
        return jsonify({k: audit_state[k] for k in ("status", "scanned", "total", "cached", "counts", "current", "started_at", "options", "fixing", "fix_queue")}
                       | {"logs": list(audit_state["logs"]), "library_totals": dict(totals), "library_size": len(library_cache_data)})

@app.route("/api/admin/audit/results", methods=["GET"])
def api_admin_audit_results():
    wanted = {s for s in (request.args.get("status") or "mismatch,wrong_version,tags_wrong,uncertain").split(",") if s}
    q = (request.args.get("q") or "").lower()
    with audit_lock:
        rows = [dict(e, rel_path=rel) for rel, e in audit_db.items() if e.get("status") in wanted and (not q or q in rel.lower())]
    order = {"mismatch": 0, "tags_wrong": 1, "wrong_version": 2, "uncertain": 3, "fixed": 4}
    rows.sort(key=lambda r: (order.get(r.get("status"), 9), r["rel_path"].lower()))
    return jsonify({"total": len(rows), "items": rows[:1000]})

@app.route("/api/admin/audit/fix", methods=["POST"])
def api_admin_audit_fix():
    d = request.get_json(silent=True) or {}
    with audit_lock:
        if d.get("all"):
            rels = [rel for rel, e in audit_db.items() if _auto_fixable(e)]
        else:
            rels = [r for r in d.get("rel_paths") or [] if (audit_db.get(r) or {}).get("status") in AUDIT_FIXABLE]
        if audit_state["status"] != "running": audit_stop.clear()
    if not rels: return jsonify({"error": "Nothing to repair"}), 400
    enqueue_fix(rels)
    audit_log(f"[FIX] Queued {len(rels)} track(s) for repair.")
    return jsonify({"message": f"Queued {len(rels)} track(s)", "queued": len(rels)})

@app.route("/api/admin/audit/ignore", methods=["POST"])
def api_admin_audit_ignore():
    rel = (request.get_json(silent=True) or {}).get("rel_path") or ""
    with audit_lock:
        e = audit_db.get(rel)
        if not e: return jsonify({"error": "Unknown track"}), 404
        audit_put(rel, dict(e, status="ignored", reason=f"Marked correct by an admin (was: {e.get('status')})"), flush=True)
    return jsonify({"message": "Ignored"})

@app.route("/api/admin/audit/quarantine", methods=["GET"])
def api_admin_audit_quarantine():
    with quarantine_lock: idx = _load_json_file(QUARANTINE_INDEX, [])
    for i in idx: i["exists"] = Path(i.get("file", "")).is_file()
    return jsonify({"items": idx})

@app.route("/api/admin/audit/restore", methods=["POST"])
def api_admin_audit_restore():
    qid = (request.get_json(silent=True) or {}).get("id") or ""
    try: rel = restore_quarantined(qid)
    except ValueError as e: return jsonify({"error": str(e)}), 404
    audit_log(f"[RESTORED] {rel} (original file put back; marked as ignored)")
    return jsonify({"message": "Restored", "rel_path": rel})

@app.route("/api/admin/audit/purge", methods=["POST"])
def api_admin_audit_purge():
    qid = (request.get_json(silent=True) or {}).get("id")
    return jsonify({"message": "Deleted", "removed": purge_quarantined(qid)})

# --- FILE BROWSER & USER CONTROLLER ---
@app.route("/api/admin/files/list", methods=["GET"])
def api_admin_files_list():
    from flask import request, jsonify
    music_dir = Path(get_real_music_dir()).resolve()
    raw_sub = request.args.get("path", "").strip()
    norm_sub = raw_sub.replace(chr(92), "/").strip("/")
    target_dir = (music_dir / norm_sub).resolve()
    if not target_dir.is_relative_to(music_dir) or not target_dir.is_dir(): return jsonify({"error": "Invalid path"}), 404
    items = []
    for entry in os.scandir(str(target_dir)):
        try:
            st = entry.stat()
            is_d = entry.is_dir()
            items.append({"name": entry.name, "rel_path": str(Path(entry.path).relative_to(music_dir)), "is_dir": is_d, "size_bytes": st.st_size if not is_d else 0})
        except Exception: pass
    items.sort(key=lambda x: (not x["is_dir"], x["name"].lower()))
    return jsonify({"current_path": norm_sub, "items": items})

# The library follows what's done here at once (no rescan): deleted songs leave it, so a downloader can fetch them
# again straight away, and renamed ones keep their likes, playlist places and history.
def _library_rels_under(rel):
    """Library entries at `rel`, or inside the folder `rel`."""
    rel = rel.strip("/")
    with library_cache_lock:
        return [r for r in library_cache_data if r == rel or r.startswith(rel + "/")]


def forget_library_paths(rels, rebuild=True):
    """Take files that are gone out of the library index and the audit."""
    gone = []
    with library_cache_lock:
        for r in rels:
            if library_cache_data.pop(r, None) is not None: gone.append(r)
            try: (COVERS_CACHE_DIR / f"{hashlib.md5(r.encode()).hexdigest()}.jpg").unlink(missing_ok=True)
            except OSError: pass
    with audit_lock:
        for r in rels: audit_db.pop(r, None)
    if gone:
        audit_flush()
        if rebuild: save_and_rebuild_cache()
    return gone


def remap_song_paths(moved):
    """Point likes, history, offline downloads, playlists and collaborative playlists at songs' new paths."""
    if not moved: return 0
    changed = 0
    with users_lock:
        for name, u in users_data.items():
            touched = False
            for key in ("liked_songs", "offline_tracks"):
                vals = u.get(key) or []
                new = list(dict.fromkeys(moved.get(r, r) for r in vals))
                if new != vals: u[key] = new; touched = True
            hist = u.get("history") or []
            if any(h.get("rel_path") in moved for h in hist):
                merged = {}
                for h in hist:
                    r = moved.get(h.get("rel_path"), h.get("rel_path"))
                    if r in merged:          # two copies of one song: one history entry
                        m = merged[r]
                        m["count"] = (m.get("count") or 1) + (h.get("count") or 1)
                        m["last_played"] = max(m.get("last_played") or "", h.get("last_played") or "")
                    else: merged[r] = dict(h, rel_path=r)
                u["history"] = list(merged.values())
                touched = True
            for pl, rels in (u.get("playlists") or {}).items():
                if isinstance(rels, list) and any(r in moved for r in rels):
                    u["playlists"][pl] = [moved.get(r, r) for r in rels]; touched = True
            if touched:
                save_users(name)
                changed += 1
    try:
        with _db_lock:
            for o, n in moved.items(): db().execute("UPDATE plays SET rel = ? WHERE rel = ?", (n, o))
    except Exception as ex:
        print(f"[WARN] Couldn't move listening log entries: {ex}")
    try:
        for pl in _pl_rows():
            if any(t.get("r") in moved for t in pl.get("tracks") or []):
                for t in pl["tracks"]: t["r"] = moved.get(t.get("r"), t.get("r"))
                pl_save(pl)
    except NameError:
        pass
    return changed


def move_library_paths(old, new):
    """After a rename: entries move with their files (tags don't change), and everything pointing at them follows."""
    moved = {r: new + r[len(old):] for r in _library_rels_under(old)}
    with library_cache_lock:
        for o, n in moved.items():
            e = library_cache_data.pop(o, None)
            if e is not None: library_cache_data[n] = e
            try:
                src = COVERS_CACHE_DIR / f"{hashlib.md5(o.encode()).hexdigest()}.jpg"
                if src.exists(): src.rename(COVERS_CACHE_DIR / f"{hashlib.md5(n.encode()).hexdigest()}.jpg")
            except OSError: pass
    with audit_lock:
        for o, n in moved.items():
            if o in audit_db: audit_db[n] = audit_db.pop(o)
    audit_flush()
    remap_song_paths(moved)
    if old in moved: refresh_library_entry(new)          # a renamed file: an untagged song's title comes from its name
    else: save_and_rebuild_cache()
    return moved


def _files_target(p):
    music_dir = Path(get_real_music_dir()).resolve()
    rel = str(p or "").strip().replace(chr(92), "/").strip("/")
    target = (music_dir / rel).resolve()
    if not target.is_relative_to(music_dir) or target == music_dir: return music_dir, None, None
    return music_dir, target, str(target.relative_to(music_dir))


@app.route("/api/admin/files/delete", methods=["POST"])
def api_admin_files_delete():
    d = request.get_json(silent=True) or {}
    music_dir, target, rel = _files_target(d.get("path"))
    if target is None: return jsonify({"error": "Forbidden"}), 403
    if not target.exists(): return jsonify({"error": "It isn't there any more."}), 404
    if target.is_dir(): shutil.rmtree(str(target))
    else: target.unlink()
    gone = forget_library_paths(_library_rels_under(rel))
    activity("files", f"Deleted {rel}" + (f" ({len(gone)} song{'s' if len(gone) != 1 else ''} left the library)" if gone else ""), admin_name(), "warn")
    return jsonify({"message": "Deleted", "path": rel, "removed_songs": len(gone)})


@app.route("/api/admin/files/rename", methods=["POST"])
def api_admin_files_rename():
    d = request.get_json(silent=True) or {}
    music_dir, target, rel = _files_target(d.get("path"))
    if target is None: return jsonify({"error": "Forbidden"}), 403
    if not target.exists(): return jsonify({"error": "It isn't there any more."}), 404
    n = clean_filename(str(d.get("new_name") or "").strip(), "")
    if not n: return jsonify({"error": "Enter a name."}), 400
    if target.is_file() and target.suffix.lower() in AUDIO_TYPES and Path(n).suffix.lower() not in AUDIO_TYPES:
        n += target.suffix                                     # keep it a song: 'Song' -> 'Song.flac'
    dest = target.parent / n
    if dest.exists() and dest.resolve() != target: return jsonify({"error": f"There's already something called '{n}' here."}), 409
    target.rename(dest)
    new_rel = str(dest.relative_to(music_dir))
    moved = move_library_paths(rel, new_rel)
    activity("files", f"Renamed {rel} to {n}", admin_name())
    return jsonify({"message": "Renamed", "new_name": n, "moved_songs": len(moved)})

@app.route("/api/admin/clean_temp", methods=["POST"])
def api_admin_clean_temp():
    from flask import jsonify
    music_dir = get_real_music_dir()
    cleaned = 0
    try:
        for root, _, files in os.walk(music_dir):
            for f in files:
                if f.endswith((".part", ".ytdl", ".temp", ".tmp")):
                    try: os.remove(os.path.join(root, f)); cleaned += 1
                    except Exception: pass
        return jsonify({"message": "Cleaned temp files", "removed_files": cleaned})
    except Exception as e: return jsonify({"error": str(e)}), 500

# ============================================================
# ADMIN v2: SELF-HOSTING CONTROLS
# ============================================================
# Everything the admin panel (web/admin.html + web/admin/) needs to run a shared server:
# one settings store with a schema the panel renders, real user management, invites,
# registration modes, a private-server switch, maintenance mode, feature toggles,
# notifications, an activity log, captured server logs, backups and system info.
#
# Some older code above is superseded here instead of being edited in place:
#   - get_current_user, get_public_settings and send_discord_notification are redefined
#     (routes look these names up when they run, so the new versions apply everywhere);
#   - the endpoints auth_register, auth_login, admin_login_page, admin_dashboard,
#     serve_admin_page, api_branding and the old api_admin_users_* / api_admin_backup_*
#     handlers get new view functions at the end of this section.
from datetime import timedelta
import importlib.metadata, platform, sys, hmac

AXDIO_CREDIT = {"text": "Created by xo.st", "url": "https://xo.st"}

# --- Settings schema (the admin panel builds its forms from this) ---
NOTIFY_EVENTS = {
    "server_started": "Server started",
    "user_registered": "Someone created an account",
    "download_complete": "A download finished",
    "login_lockout": "Too many failed logins from one address",
}
ADMIN_SCHEMA = [
    {"id": "general", "title": "General", "fields": [
        {"key": "site_title", "type": "text", "label": "Server name", "default": "Axdio", "max": 40,
         "help": "Shown in the app, the browser tab and on installed home-screen apps."},
        {"key": "site_tagline", "type": "text", "label": "Tagline", "default": "Lossless Self-Hosted Music Streaming", "max": 80},
        {"key": "public_url", "type": "url", "label": "Public URL", "default": "",
         "placeholder": "https://music.example.com",
         "help": "Used for share and invite links. Leave empty to use whatever address people open the server on."},
        {"key": "meta_description", "type": "textarea", "label": "Description for link previews", "default": "Self-hosted personal music library streaming platform.", "max": 300},
        {"key": "allow_indexing", "type": "bool", "label": "Let search engines index this server", "default": False,
         "help": "Off keeps the server out of Google and friends (noindex + robots.txt)."},
    ]},
    {"id": "appearance", "title": "Appearance", "fields": [
        {"key": "accent_color", "type": "color", "label": "Accent colour", "default": "#22c55e",
         "help": "Default accent for everyone. Listeners can still pick their own in Settings."},
        {"key": "announcement_text", "type": "textarea", "label": "Announcement banner", "default": "", "max": 400,
         "placeholder": "e.g. The server will be down for maintenance on Sunday at 10:00.",
         "help": "Shown at the top of the app until each listener dismisses it. Leave empty for none."},
        {"key": "announcement_level", "type": "select", "label": "Banner style", "default": "info",
         "options": [["info", "Info"], ["success", "Good news"], ["warning", "Warning"]]},
        {"key": "custom_css", "type": "code", "label": "Custom CSS", "default": "", "max": 100000, "lang": "css",
         "help": "Added to the desktop and mobile apps after their own styles."},
        {"key": "custom_head", "type": "code", "label": "Custom <head> HTML", "default": "", "max": 20000, "lang": "html",
         "help": "Inserted into every app page, e.g. a self-hosted analytics snippet (Plausible, Umami). Not added to the admin panel."},
    ]},
    {"id": "features", "title": "Features", "fields": [
        {"key": "feature_lyrics", "type": "bool", "label": "Lyrics", "default": True, "help": "Synced lyrics from LRCLIB."},
        {"key": "feature_offline", "type": "bool", "label": "Downloads to devices", "default": True, "help": "Listeners can save songs for offline listening."},
        {"key": "feature_connect", "type": "bool", "label": "Connect", "default": True, "help": "See other devices and move playback between them."},
        {"key": "feature_sharing", "type": "bool", "label": "Sharing", "default": True,
         "help": "Listeners can copy links to songs, albums and artists. A link shows the title, artist and artwork in chat apps like Discord, and opens a page where anyone can listen (on a private server, after signing in)."},
        {"key": "share_previews", "type": "bool", "label": "Link previews on a private server", "default": True,
         "help": "On a private server, shared links still show the title, artist and artwork to anyone who has the link. Turn off to keep everything about a shared link behind sign-in."},
        {"key": "feature_avatars", "type": "bool", "label": "Profile photos", "default": True, "help": "Listeners can upload a profile photo. You can remove anyone's photo under Accounts & access."},
        {"key": "feature_social", "type": "bool", "label": "Friends", "default": True,
         "help": "Listeners can add friends, see what their friends are playing (unless they turn that off) and visit their profiles. Messages and collaborative playlists need this."},
        {"key": "feature_chat", "type": "bool", "label": "Private messages", "default": True,
         "help": "End-to-end encrypted chats between friends, one to one or in groups. Keys stay on listeners' devices, so messages can't be read on the server, in backups or by admins."},
        {"key": "chat_group_max", "type": "number", "label": "Largest group chat", "default": 32, "min": 3, "max": 64},
        {"key": "chat_retention_days", "type": "number", "label": "Delete messages after (days)", "default": 0, "min": 0, "max": 3650,
         "help": "0 keeps messages until people delete them. Older messages are removed from the server once an hour."},
        {"key": "chat_media_images", "type": "bool", "label": "Photos in messages", "default": True,
         "help": "Encrypted on the sender's device before they're uploaded, like the messages themselves. Location and camera details are removed from photos before sending."},
        {"key": "chat_media_videos", "type": "bool", "label": "Videos in messages", "default": True},
        {"key": "chat_media_voice", "type": "bool", "label": "Voice messages", "default": True},
        {"key": "chat_media_max_mb", "type": "number", "label": "Largest photo, video or voice message (MB)", "default": 100, "min": 1, "max": 4096},
        {"key": "chat_media_quota_mb", "type": "number", "label": "Space for each listener's attachments (MB)", "default": 2048, "min": 0, "max": 1000000,
         "help": "How much each listener can have stored in chats at once. Unsending, disappearing messages and deleting old messages free it up. 0 means no limit."},
        {"key": "feature_collab", "type": "bool", "label": "Collaborative playlists", "default": True, "help": "Playlist owners can invite friends to add, remove and reorder songs."},
        {"key": "feature_party", "type": "bool", "label": "Listening parties", "default": True,
         "help": "Listeners start a party and everyone who joins (with the code or link, or as a friend) hears the same song at the same moment, with a shared queue, reactions and chat."},
        {"key": "feature_daily", "type": "bool", "label": "Axdio Daily", "default": True,
         "help": "A daily game: everyone on the server gets the same song and names it from a 1-second clip, then longer ones. Streaks, a shareable result and friends' scores. Songs come from what's popular on this server."},
        {"key": "feature_discover", "type": "bool", "label": "Discover", "default": True,
         "help": "A feed of songs each listener has never played, one swipe at a time, each starting at its catchiest part. Mixes in what friends have on repeat (only friends who share their listening)."},
        {"key": "feature_notes", "type": "bool", "label": "Music notes", "default": True,
         "help": "Friends can leave a short note with a song for each other, shown above their chats for 24 hours. Replies go to their private messages."},
        {"key": "feature_chart", "type": "bool", "label": "Friends Chart", "default": True,
         "help": "A weekly top 20 of the songs a listener and their friends play most, with how each moved since last week. Only friends who share their listening count."},
        {"key": "feature_capsule", "type": "bool", "label": "Time capsule", "default": True,
         "help": "Shows listeners what they played on this day in earlier years (or a month ago), and favourites they haven't played in a while."},
        {"key": "feature_achievements", "type": "bool", "label": "Levels and achievements", "default": True,
         "help": "Listeners earn XP and levels from listening, keep a daily streak going and unlock badges (Night Owl, Explorer, Album Purist…). Friends see each other's level, streak and best badges when they share their listening."},
        {"key": "feature_rewind", "type": "bool", "label": "Rewind", "default": True,
         "help": "Each listener gets their month and year in music: minutes, top artists and songs, listening habits and a card to share. Only they can see their numbers."},
        {"key": "feature_smart", "type": "bool", "label": "Smart transitions", "default": True,
         "help": "Trims silence between songs, times crossfades to where each song really ends and can even out volume. Each song is measured once with ffmpeg the first time it's played or queued (a few seconds of CPU at low priority)."},
        {"key": "feature_subsonic", "type": "bool", "label": "Subsonic apps", "default": True,
         "help": "Lets listeners use Subsonic-compatible apps (Symfonium, Feishin, DSub, Substreamer…) with an app password from their Settings. The API lives at /rest."},
        {"key": "feature_scrobbling", "type": "bool", "label": "Scrobbling", "default": True,
         "help": "Listeners can send what they play to ListenBrainz or Last.fm (Last.fm also needs an API key below)."},
        {"key": "feature_transcoding", "type": "bool", "label": "Data saver streaming", "default": True,
         "help": "Listeners can choose smaller MP3 streams (320, 192 or 128 kbps) instead of lossless files. Encoding uses the server's CPU; finished songs are cached."},
        {"key": "transcode_cache_mb", "type": "number", "label": "Space for data saver copies (MB)", "default": 2048, "min": 100, "max": 200000},
        {"key": "default_crossfade", "type": "number", "label": "Default crossfade (seconds)", "default": 0, "min": 0, "max": 12,
         "help": "Starting playback settings for new listeners and devices."},
        {"key": "default_gapless", "type": "bool", "label": "Gapless playback by default", "default": True},
        {"key": "default_normalize", "type": "bool", "label": "Volume normalization by default", "default": False},
    ]},
    {"id": "access", "title": "Access", "fields": [
        {"key": "registration", "type": "select", "label": "Sign-ups", "default": "open",
         "options": [["open", "Anyone can create an account"], ["invite", "Invite code required"], ["closed", "Closed: only admins create accounts"]]},
        {"key": "require_login", "type": "bool", "label": "Private server", "default": False,
         "help": "Require an account to browse and listen. When off, anyone who can reach the server can listen, and accounts only sync likes and playlists."},
        {"key": "min_password_length", "type": "number", "label": "Minimum password length", "default": 6, "min": 4, "max": 64},
        {"key": "session_days", "type": "number", "label": "Keep people signed in for (days)", "default": 30, "min": 1, "max": 365},
    ]},
    {"id": "discord", "title": "Discord", "fields": [
        {"key": "discord_login", "type": "bool", "label": "Sign in with Discord", "default": False,
         "help": "Listeners can sign in or sign up with Discord, and connect Discord to an account they already have. New accounts follow the sign-up setting above."},
        {"key": "discord_presence", "type": "bool", "label": "Discord status", "default": True,
         "help": "Listeners can show what they're playing as their Discord status, using a small helper they run on the computer where Discord is open."},
        {"key": "discord_client_id", "type": "text", "label": "Application ID", "default": "", "max": 24, "pattern": r"\d{15,22}",
         "pattern_error": "The Application ID is a long number, like 1290000000000000001.",
         "help": "Make an application at discord.com/developers/applications and copy its Application ID. Its name and icon appear in people's status, so name it after your server."},
        {"key": "discord_client_secret", "type": "secret-text", "label": "Client secret", "default": "", "max": 100,
         "help": "Only needed for signing in. On the application's OAuth2 page, copy the client secret and add the redirect shown below."},
    ]},
    {"id": "federation", "title": "Library sharing", "fields": [
        {"key": "federation_enabled", "type": "bool", "label": "Allow library sharing", "default": True,
         "help": "Share this server's music with other Axdio servers and play what they share with you. Nothing is shared until you make a share key."},
        {"key": "federation_sync_minutes", "type": "number", "label": "Check shared libraries for changes every (minutes)", "default": 60, "min": 10, "max": 1440},
    ]},
    {"id": "plugins", "title": "Plugins", "fields": [
        {"key": "plugins_check_hours", "type": "number", "label": "Check for plugin updates every (hours)", "default": 24, "min": 1, "max": 168,
         "help": "Plugins with automatic updates turned on install new versions when they're found, as long as nothing is downloading."},
    ]},
    {"id": "updates", "title": "Updates", "fields": [
        {"key": "updates_check", "type": "bool", "label": "Check for new versions", "default": True,
         "help": "Looks up the published versions of Axdio a few times a day and tells you (here, and by notification) when there's a new one."},
        {"key": "updates_auto", "type": "bool", "label": "Install new versions automatically", "default": False,
         "help": "At the hour below, when nothing is downloading. The server restarts, so listeners are interrupted for about a minute."},
        {"key": "updates_hour", "type": "select", "label": "Install at", "default": "4",
         "options": [[str(h), f"{h:02d}:00"] for h in range(24)]},
    ]},
    {"id": "security", "title": "Security", "fields": [
        {"key": "force_ssl", "type": "bool", "label": "Redirect HTTP to HTTPS", "default": False,
         "help": "Only turn on when the server is reached over HTTPS (usually through a reverse proxy)."},
        {"key": "trust_proxy", "type": "bool", "label": "Behind a reverse proxy", "default": True,
         "help": "Read the visitor's address from X-Forwarded-For. Turn off if the server is exposed directly, so addresses can't be spoofed."},
        {"key": "login_max_attempts", "type": "number", "label": "Failed logins before a 15-minute lockout", "default": 10, "min": 3, "max": 100},
        {"key": "metrics_token", "type": "secret-text", "label": "Prometheus metrics token", "default": "", "max": 64,
         "help": "Set a token (letters and numbers) to expose /metrics for Prometheus or Grafana Agent; send it as a Bearer token. Empty keeps /metrics off."},
    ]},
    {"id": "notifications", "title": "Notifications", "fields": [
        {"key": "discord_webhook", "type": "secret", "label": "Discord webhook URL", "default": "", "placeholder": "https://discord.com/api/webhooks/…"},
        {"key": "webhook_url", "type": "url", "label": "Generic webhook URL", "default": "", "placeholder": "https://ntfy.sh/my-topic",
         "help": "Receives a JSON POST: {event, title, message, server, time}. Works with ntfy, Gotify bridges, Home Assistant and n8n."},
        {"key": "notify_events", "type": "multi", "label": "Send notifications for", "default": ["user_registered", "download_complete", "login_lockout"],
         "options": [[k, v] for k, v in NOTIFY_EVENTS.items()]},
    ]},
    {"id": "scrobbling", "title": "Scrobbling", "fields": [
        {"key": "lastfm_api_key", "type": "text", "label": "Last.fm API key", "default": "", "max": 64,
         "help": "Create an API account at last.fm/api/account/create (the callback URL is your server address + /api/user/scrobbling/lastfm/callback). ListenBrainz needs nothing here."},
        {"key": "lastfm_api_secret", "type": "secret-text", "label": "Last.fm shared secret", "default": "", "max": 64},
    ]},
    {"id": "library", "title": "Library", "fields": [
        {"key": "scan_interval", "type": "select", "label": "Look for new and changed files", "default": "60",
         "options": [["5", "Every 5 minutes"], ["15", "Every 15 minutes"], ["60", "Every hour"], ["360", "Every 6 hours"],
                     ["1440", "Once a day"], ["0", "Only when I press Scan now"]],
         "help": "Each scan checks every file in the music folder, so remote or network storage is happier with longer gaps. Downloads made here appear straight away."},
    ]},
    {"id": "backups", "title": "Automatic backups", "fields": [
        {"key": "backup_schedule", "type": "select", "label": "Back up automatically", "default": "daily",
         "options": [["off", "Off"], ["daily", "Every day"], ["weekly", "Every week"]],
         "help": "Saves settings, accounts (with likes, playlists and history) and invites to config/backups. Music isn't included."},
        {"key": "backup_keep", "type": "number", "label": "Backups to keep", "default": 7, "min": 1, "max": 90},
    ]},
    {"id": "maintenance", "title": "Maintenance", "fields": [
        {"key": "maintenance_mode", "type": "bool", "label": "Maintenance mode", "default": False,
         "help": "Everyone except signed-in admins sees a maintenance page."},
        {"key": "maintenance_message", "type": "textarea", "label": "Maintenance message", "default": "We're doing some work on the server. Back soon!", "max": 400},
    ]},
]
SCHEMA_FIELDS = {f["key"]: f for sec in ADMIN_SCHEMA for f in sec["fields"]}
SCHEMA_DEFAULTS = {k: f["default"] for k, f in SCHEMA_FIELDS.items()}

# --- One settings store ---
# settings.json is the source of truth; cfg() re-reads it when the file changes.
_cfg_state = {"mtime": None, "data": {}, "raw": {}}
_cfg_lock = threading.RLock()

def cfg():
    with _cfg_lock:
        try: mtime = SETTINGS_FILE.stat().st_mtime
        except OSError: mtime = None
        if mtime != _cfg_state["mtime"] or not _cfg_state["data"]:
            data = {}
            if mtime is not None:
                try:
                    with open(SETTINGS_FILE, "r", encoding="utf-8") as f: data = json.load(f)
                except Exception: data = dict(_cfg_state["data"])   # mid-write: keep the last good copy
            merged = {**SCHEMA_DEFAULTS, **data}
            _cfg_state.update(mtime=mtime, data=merged, raw=data)
            app.permanent_session_lifetime = timedelta(days=int(merged.get("session_days") or 30))
            app.config["SESSION_COOKIE_SECURE"] = bool(merged.get("force_ssl"))
        return _cfg_state["data"]

def cfg_save(updates):
    # Only explicitly saved values go to disk, so later versions can change the defaults.
    with _cfg_lock:
        cfg()
        data = {**_cfg_state["raw"], **updates}
        tmp = SETTINGS_FILE.with_suffix(".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
            f.flush(); os.fsync(f.fileno())
        os.replace(tmp, SETTINGS_FILE)
        _cfg_state["mtime"] = None
        return cfg()

def _coerce(field, value):
    """Validate one submitted value against its schema field; raises ValueError with a readable message."""
    t, label = field["type"], field["label"]
    if t == "bool": return bool(value)
    if t == "number":
        try: n = int(float(value))
        except (TypeError, ValueError): raise ValueError(f"{label} must be a number.")
        return max(field.get("min", n), min(field.get("max", n), n))
    if t == "select":
        if value not in [o[0] for o in field["options"]]: raise ValueError(f"Pick one of the options for {label}.")
        return value
    if t == "multi":
        allowed = {o[0] for o in field["options"]}
        return [v for v in (value or []) if v in allowed]
    s = str(value or "").strip() if t != "code" else str(value or "")
    if len(s) > field.get("max", 2000): raise ValueError(f"{label} is too long (max {field.get('max', 2000)} characters).")
    if t == "color" and not re.fullmatch(r"#[0-9a-fA-F]{6}", s): raise ValueError(f"{label} must look like #22c55e.")
    if t in ("url", "secret") and s and not re.match(r"^https?://[^\s]+$", s): raise ValueError(f"{label} must start with http:// or https://.")
    if field.get("pattern") and s and not re.fullmatch(field["pattern"], s): raise ValueError(field.get("pattern_error") or f"{label} doesn't look right.")
    if t == "secret-text" and s and not re.fullmatch(r"[A-Za-z0-9_-]+", s): raise ValueError(f"{label} should only contain letters, numbers, dashes and underscores.")
    if t == "url": s = s.rstrip("/")
    return s

# --- Persistent session key: without it every restart signs everyone out ---
if not (os.environ.get("SECRET_KEY") or os.environ.get("FLASK_SECRET_KEY")):
    _key_file = CONFIG_DIR / "secret_key"
    try: _key = _key_file.read_text().strip()
    except OSError: _key = ""
    if len(_key) < 32:
        _key = secrets.token_hex(32)
        try:
            _key_file.write_text(_key)
            os.chmod(_key_file, 0o600)
        except OSError: pass
    app.secret_key = _key
app.config.update(SESSION_COOKIE_SAMESITE="Lax", SESSION_COOKIE_HTTPONLY=True)

# --- Captured server output (Logs page) ---
_log_lines = collections.deque(maxlen=2000)
_log_seq = [0]
_log_lock = threading.Lock()

class _LogTee:
    def __init__(self, stream):
        self.stream, self.buf = stream, ""
    def write(self, s):
        try: self.stream.write(s)
        except Exception: pass
        with _log_lock:
            self.buf += s
            while "\n" in self.buf:
                line, self.buf = self.buf.split("\n", 1)
                if line.strip():
                    _log_seq[0] += 1
                    _log_lines.append((_log_seq[0], time.time(), line[:2000]))
        return len(s)
    def flush(self):
        try: self.stream.flush()
        except Exception: pass
    def __getattr__(self, name): return getattr(self.stream, name)

if not isinstance(sys.stdout, _LogTee): sys.stdout = _LogTee(sys.stdout)
if not isinstance(sys.stderr, _LogTee): sys.stderr = _LogTee(sys.stderr)

# Python logging (Flask errors, library warnings) goes through stdout too, so the Logs page shows it.
import logging
_log_handler = logging.StreamHandler(sys.stdout)
_log_handler.setFormatter(logging.Formatter("[%(levelname)s] %(name)s: %(message)s"))
logging.getLogger().addHandler(_log_handler)
logging.getLogger().setLevel(os.environ.get("LOG_LEVEL", "INFO").upper())

# --- Activity log (logins, sign-ups, admin changes) ---
ACTIVITY_FILE = CONFIG_DIR / "activity.jsonl"
_activity = collections.deque(maxlen=1000)
_activity_lock = threading.Lock()
try:
    with open(ACTIVITY_FILE, "r", encoding="utf-8") as f:
        for line in f.readlines()[-1000:]:
            try: _activity.append(json.loads(line))
            except Exception: pass
except OSError: pass

def client_ip():
    if cfg().get("trust_proxy", True):
        fwd = request.headers.get("X-Forwarded-For", "")
        if fwd: return fwd.split(",")[0].strip()
    return request.remote_addr or ""

def activity(kind, message, who=None, level="info"):
    entry = {"t": time.time(), "kind": kind, "msg": message, "who": who, "level": level}
    try: entry["ip"] = client_ip()
    except RuntimeError: pass   # outside a request
    with _activity_lock:
        _activity.append(entry)
        try:
            if ACTIVITY_FILE.exists() and ACTIVITY_FILE.stat().st_size > 2 * 1024 * 1024:
                with open(ACTIVITY_FILE, "w", encoding="utf-8") as f:
                    f.writelines(json.dumps(e) + "\n" for e in _activity)
            else:
                with open(ACTIVITY_FILE, "a", encoding="utf-8") as f: f.write(json.dumps(entry) + "\n")
        except OSError: pass

def admin_name():
    return session.get("admin_user") or cfg().get("admin_user") or "admin"

# --- Notifications (Discord + generic JSON webhook) ---
def _post_webhook(url, payload):
    try:
        req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"),
                                     headers={"Content-Type": "application/json", "User-Agent": "Axdio-Server"})
        with urllib.request.urlopen(req, timeout=6) as r: return r.status < 300
    except Exception: return False

def notify(event, title, message, color=2278750, wait=False):
    """Send to every configured channel. Known events obey the admin's event choices."""
    c = cfg()
    if event in NOTIFY_EVENTS and event not in (c.get("notify_events") or []): return {}
    def run():
        out = {}
        if c.get("discord_webhook"):
            out["discord"] = _post_webhook(c["discord_webhook"], {"embeds": [{
                "title": title, "description": message, "color": color, "footer": {"text": c.get("site_title", "Axdio")},
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}]})
        if c.get("webhook_url"):
            out["webhook"] = _post_webhook(c["webhook_url"], {"event": event, "title": title, "message": message,
                                                              "server": c.get("site_title", "Axdio"), "time": datetime.now().isoformat()})
        return out
    if wait: return run()
    threading.Thread(target=run, daemon=True).start()
    return {}

def send_discord_notification(title, message, color=2278750):
    # Existing callers (plugins included) now go through notify(), which also honours the event choices.
    event = "download_complete" if str(title).lower().startswith("download") else "general"
    return notify(event, title, message, color)

# --- Users ---
# Accounts live in config/axdio.db (SQLite, one JSON row per account). users.json from older
# versions is imported once and renamed to users.json.migrated. Login tokens are stored as
# SHA-256 hashes; the plain token only ever exists on the listener's device.
import sqlite3
USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{1,31}$")
DB_FILE = CONFIG_DIR / "axdio.db"
# Private messages (conversations, message ciphertext and encrypted attachments) have a folder of their own, so they
# can live on another disk or an encrypted volume and be backed up on their own schedule. Set it with CHAT_DIR.
CHAT_DIR = Path(os.environ.get("CHAT_DIR") or CONFIG_DIR / "chat")
CHAT_DB_FILE = CHAT_DIR / "chat.db"
CHAT_MEDIA_DIR = CHAT_DIR / "media"
_db_lock = threading.RLock()
_db_conn = None
_saved_rows = {}

def db():
    global _db_conn
    if _db_conn is None:
        _db_conn = sqlite3.connect(str(DB_FILE), timeout=30, check_same_thread=False, isolation_level=None)
        _db_conn.execute("PRAGMA journal_mode=WAL")
        _db_conn.execute("PRAGMA synchronous=NORMAL")
        _db_conn.execute("CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, data TEXT NOT NULL, updated REAL)")
        _db_conn.execute("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)")
        # Social: collaborative playlists, conversations (JSON rows) and end-to-end encrypted messages.
        _db_conn.execute("CREATE TABLE IF NOT EXISTS shared_playlists (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated REAL)")
        # Rewind's listening log, and Smart transitions' measurements of each song.
        _db_conn.execute("CREATE TABLE IF NOT EXISTS plays (user TEXT NOT NULL, ts REAL NOT NULL, rel TEXT NOT NULL, secs REAL NOT NULL, "
                         "n INTEGER NOT NULL DEFAULT 1, b INTEGER NOT NULL DEFAULT 0)")
        _db_conn.execute("CREATE INDEX IF NOT EXISTS plays_user_ts ON plays (user, ts)")
        _db_conn.execute("CREATE TABLE IF NOT EXISTS analysis (rel TEXT PRIMARY KEY, mtime REAL NOT NULL, data TEXT NOT NULL)")
        _db_conn.execute("CREATE TABLE IF NOT EXISTS events (user TEXT NOT NULL, ts REAL NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL DEFAULT '')")
        _db_conn.execute("CREATE INDEX IF NOT EXISTS events_user_kind ON events (user, kind)")
        _db_conn.execute("CREATE TABLE IF NOT EXISTS daily (user TEXT NOT NULL, day TEXT NOT NULL, tries TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, "
                         "solved INTEGER NOT NULL DEFAULT 0, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user, day))")
        _chat_attach(_db_conn)
    return _db_conn

def _chat_attach(conn):
    """Open chat.db in CHAT_DIR on the same connection. Its tables keep their plain names in queries: SQLite looks
    in the main database first and then in attached ones, and once moved, axdio.db no longer has them."""
    try:
        CHAT_DIR.mkdir(parents=True, exist_ok=True)
        conn.execute("ATTACH DATABASE ? AS chat", (str(CHAT_DB_FILE),))
    except Exception as ex:
        raise RuntimeError(f"Can't open the chat folder {CHAT_DIR} ({ex}). Check that it exists and Axdio can write to it.") from ex
    conn.execute("PRAGMA chat.journal_mode=WAL")
    conn.execute("PRAGMA chat.synchronous=NORMAL")
    conn.execute("CREATE TABLE IF NOT EXISTS chat.conversations (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated REAL)")
    conn.execute("CREATE TABLE IF NOT EXISTS chat.conv_members (conv TEXT NOT NULL, user TEXT NOT NULL, read_seq INTEGER NOT NULL DEFAULT 0, "
                 "hidden_seq INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (conv, user))")
    conn.execute("CREATE INDEX IF NOT EXISTS chat.conv_members_user ON conv_members (user)")
    conn.execute("CREATE TABLE IF NOT EXISTS chat.messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, conv TEXT NOT NULL, "
                 "sender TEXT NOT NULL, ts REAL NOT NULL, data TEXT NOT NULL, expires REAL)")
    if "expires" not in {r[1] for r in conn.execute("PRAGMA chat.table_info(messages)")}:
        conn.execute("ALTER TABLE chat.messages ADD COLUMN expires REAL")
    conn.execute("CREATE INDEX IF NOT EXISTS chat.messages_conv ON messages (conv, seq)")
    conn.execute("CREATE INDEX IF NOT EXISTS chat.messages_expires ON messages (expires) WHERE expires IS NOT NULL")
    # Encrypted attachments: the chunks are files under media/, this is what the server knows about them.
    conn.execute("CREATE TABLE IF NOT EXISTS chat.files (id TEXT PRIMARY KEY, conv TEXT NOT NULL, sender TEXT NOT NULL, ts REAL NOT NULL, "
                 "kind TEXT NOT NULL, size INTEGER NOT NULL, chunks INTEGER NOT NULL, ready INTEGER NOT NULL DEFAULT 0, msg TEXT)")
    for col in ("conv", "sender", "msg"): conn.execute(f"CREATE INDEX IF NOT EXISTS chat.files_{col} ON files ({col})")
    _chat_migrate(conn)

def _chat_migrate(conn):
    """Versions before 2.6.0 kept chats inside axdio.db: copy them into chat.db once, and keep the old tables, renamed."""
    main = {r[0] for r in conn.execute("SELECT name FROM main.sqlite_master WHERE type = 'table'")}
    old = [t for t in ("conversations", "conv_members", "messages") if t in main]
    fresh = not conn.execute("SELECT 1 FROM chat.conversations LIMIT 1").fetchone() and not conn.execute("SELECT 1 FROM chat.messages LIMIT 1").fetchone()
    if not old:
        if fresh and any(n.startswith("moved_conversations_") for n in main):
            print(f"[WARN] {CHAT_DB_FILE} is empty, but chats were moved out of axdio.db before. If you changed CHAT_DIR, "
                  "copy chat.db and the media folder over from the old chat folder.")
        return
    stamp = time.strftime("%Y%m%d%H%M%S")
    moved = {}
    conn.execute("BEGIN IMMEDIATE")
    try:
        for t in old:
            if fresh:
                cols = ",".join(r[1] for r in conn.execute(f"PRAGMA main.table_info({t})"))
                moved[t] = conn.execute(f"INSERT INTO chat.{t} ({cols}) SELECT {cols} FROM main.{t}").rowcount
            conn.execute(f"ALTER TABLE main.{t} RENAME TO moved_{t}_{stamp}")
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    if any(moved.values()):
        print(f"[INFO] Moved private messages into {CHAT_DB_FILE} ({moved.get('conversations', 0)} conversations, {moved.get('messages', 0)} messages). "
              f"The old copies stay in axdio.db as moved_*_{stamp} tables; they're encrypted like the originals.")

def token_hash(token):
    return hashlib.sha256(str(token).encode()).hexdigest()

def _normalize_user(name, rec):
    rec.setdefault("tokens", [rec["token"]] if rec.get("token") else [])
    rec.pop("token", None)
    rec["tokens"] = [t if len(t) == 64 else token_hash(t) for t in rec["tokens"] if t]
    pw = rec.get("password") or ""
    if pw and "$" not in pw: rec["password"] = hash_pw(pw)
    rec.setdefault("offline_tracks", [])
    rec.setdefault("history", [])
    rec.setdefault("liked_songs", [])
    rec.setdefault("playlists", {})
    rec.setdefault("display_name", name.capitalize())
    rec.setdefault("avatar", "")
    rec.setdefault("preferences", {"crossfade": 0, "audio_quality": "flac", "theme_accent": "#1ed760", "gapless": True,
                                   "normalize_volume": False, "compact_mode": False})
    return rec

def load_users():
    global users_data
    with _db_lock:
        rows = db().execute("SELECT username, data FROM users").fetchall()
        if not rows and USERS_FILE.exists():
            try:
                with open(USERS_FILE, "r", encoding="utf-8") as f: legacy = json.load(f)
            except Exception as ex:
                print(f"[ERROR] Could not read {USERS_FILE}: {ex}")
                legacy = {}
            if isinstance(legacy, dict) and legacy:
                with users_lock:
                    users_data = {u: _normalize_user(u, r) for u, r in legacy.items() if isinstance(r, dict)}
                    save_users()
                USERS_FILE.rename(USERS_FILE.with_name("users.json.migrated"))
                print(f"[INFO] Moved {len(users_data)} accounts from users.json into axdio.db")
                return
        loaded = {}
        for u, data in rows:
            try: loaded[u] = _normalize_user(u, json.loads(data))
            except Exception: print(f"[ERROR] Skipping unreadable account row: {u}")
        with users_lock:
            users_data = loaded
            _saved_rows.clear()
            _saved_rows.update({u: json.dumps(r, sort_keys=True) for u, r in loaded.items()})

def save_users(only=None):
    """Write changed accounts (or just `only`) in one transaction."""
    with users_lock, _db_lock:
        names = [only] if only else list(users_data.keys())
        changed = []
        for u in names:
            rec = users_data.get(u)
            if rec is None: continue
            blob = json.dumps(rec, sort_keys=True)
            if _saved_rows.get(u) != blob: changed.append((u, blob))
        removed = [] if only else [u for u in _saved_rows if u not in users_data]
        if not changed and not removed: return
        conn = db()
        try:
            conn.execute("BEGIN")
            now = time.time()
            conn.executemany("INSERT INTO users (username, data, updated) VALUES (?, ?, ?) ON CONFLICT(username) DO UPDATE SET data=excluded.data, updated=excluded.updated",
                             [(u, b, now) for u, b in changed])
            conn.executemany("DELETE FROM users WHERE username = ?", [(u,) for u in removed])
            conn.execute("COMMIT")
        except Exception as ex:
            conn.execute("ROLLBACK")
            print(f"[ERROR] Saving accounts failed: {ex}")
            return
        for u, b in changed: _saved_rows[u] = b
        for u in removed: _saved_rows.pop(u, None)

def device_label(ua):
    ua = ua or ""
    osname = next((n for k, n in (("iPhone", "iPhone"), ("iPad", "iPad"), ("Android", "Android"), ("Windows", "Windows"),
                                  ("Macintosh", "Mac"), ("CrOS", "ChromeOS"), ("Linux", "Linux")) if k in ua), "")
    browser = next((n for k, n in (("Edg/", "Edge"), ("OPR/", "Opera"), ("Firefox/", "Firefox"), ("Chrome/", "Chrome"),
                                   ("Safari/", "Safari")) if k in ua), "")
    if browser and osname: return f"{browser} on {osname}"
    return browser or osname or (ua.split("/")[0][:40] if ua else "Unknown device")

def issue_token(rec):
    token = secrets.token_hex(24)
    h = token_hash(token)
    rec.setdefault("tokens", []).append(h)
    rec["tokens"] = rec["tokens"][-20:]   # the 20 most recent devices stay signed in
    try: device = device_label(request.headers.get("User-Agent", ""))
    except RuntimeError: device = ""
    sessions = rec.setdefault("sessions", {})
    sessions[h] = {"created": time.time(), "device": device}
    rec["sessions"] = {k: v for k, v in sessions.items() if k in rec["tokens"]}
    return token

def get_current_user():
    # A token must be one issued at login (sent as a header, never in the URL); a cookie session
    # must match the account's session epoch, which "sign out everywhere" and password resets bump.
    token = request.headers.get("X-Auth-Token")
    with users_lock:
        if token:
            h = token_hash(token)
            for u, data in users_data.items():
                if h in data.get("tokens", []):
                    return None if data.get("disabled") else u
            return None
        user = session.get("user")
        rec = users_data.get(user)
        if not rec or rec.get("disabled"): return None
        if session.get("epoch", 0) != rec.get("session_epoch", 0): return None
        return user

def connect_owner():
    """Whose Connect devices a request sees: the account, or everyone signed out on the same network."""
    return get_current_user() or "guest@" + client_ip()

def _new_user_record(password, display_name, is_admin=False):
    return {
        "password": hash_pw(password), "tokens": [], "created": datetime.now().isoformat(),
        "display_name": display_name, "avatar": "", "is_admin": bool(is_admin), "disabled": False, "session_epoch": 0,
        "liked_songs": [], "playlists": {}, "offline_tracks": [], "history": [],
        "preferences": {"crossfade": 0, "audio_quality": "flac", "theme_accent": "#1ed760", "gapless": True,
                        "normalize_volume": False, "compact_mode": False},
    }

def _start_user_session(username):
    rec = users_data[username]
    session["user"] = username
    session["epoch"] = rec.get("session_epoch", 0)
    session.permanent = True

def _check_password(pw):
    n = int(cfg().get("min_password_length") or 6)
    if len(pw) < n: return f"Use at least {n} characters for the password."
    return None

def _revoke_sessions(rec):
    rec["tokens"] = []
    rec["sessions"] = {}
    rec["session_epoch"] = rec.get("session_epoch", 0) + 1

# --- Self-service: devices, data export, account deletion ---
def _me():
    u = get_current_user()
    if not u: abort(Response(json.dumps({"error": "Sign in first."}), 401, mimetype="application/json"))
    return u

@app.route("/api/user/sessions")
def user_sessions():
    u = _me()
    cur = token_hash(request.headers.get("X-Auth-Token", ""))
    with users_lock:
        rec = users_data[u]
        meta = rec.get("sessions", {})
        out = [{"id": h[:16], "current": h == cur, "created": meta.get(h, {}).get("created"),
                "device": meta.get(h, {}).get("device") or ""} for h in reversed(rec.get("tokens", []))]
    return jsonify({"sessions": out})

@app.route("/api/user/sessions/revoke", methods=["POST"])
def user_sessions_revoke():
    u = _me()
    d = request.get_json(silent=True) or {}
    cur = token_hash(request.headers.get("X-Auth-Token", ""))
    with users_lock:
        rec = users_data[u]
        before = len(rec.get("tokens", []))
        if d.get("others"):
            rec["tokens"] = [h for h in rec.get("tokens", []) if h == cur]
            rec["session_epoch"] = rec.get("session_epoch", 0) + 1   # also ends browser sessions elsewhere
        else:
            sid = str(d.get("id") or "")
            if len(sid) < 8: return jsonify({"error": "Pick a device."}), 400
            rec["tokens"] = [h for h in rec.get("tokens", []) if not h.startswith(sid) or h == cur]
        rec["sessions"] = {h: m for h, m in rec.get("sessions", {}).items() if h in rec["tokens"]}
        removed = before - len(rec["tokens"])
        save_users(u)
        _start_user_session(u)
    activity("account", f"Signed out {removed} device{'s' if removed != 1 else ''}", u)
    return jsonify({"ok": True, "removed": removed})

@app.route("/api/user/export")
def user_export():
    u = _me()
    with users_lock:
        rec = json.loads(json.dumps(users_data[u]))
    for k in ("password", "tokens", "sessions", "session_epoch", "subsonic", "scrobbling", "e2ee", "presence"): rec.pop(k, None)
    rec["collaborative_playlists"] = [{"name": pl["name"], "owner": pl["owner"], "collaborators": pl["collaborators"],
                                       "songs": [t["r"] for t in pl["tracks"]]} for pl in playlists_of(u)]
    with _db_lock:
        rec["listening_log"] = [{"time": datetime.fromtimestamp(ts).isoformat(timespec="seconds"), "song": rel, "plays": n, "from_history": bool(b)}
                                for ts, rel, n, b in db().execute("SELECT ts, rel, n, b FROM plays WHERE user = ? ORDER BY ts", (u,))]
    body = {"format": "axdio-user-export", "exported_at": datetime.now().isoformat(), "server": cfg().get("site_title", "Axdio"),
            "username": u, "account": rec}
    return Response(json.dumps(body, indent=2), mimetype="application/json",
                    headers={"Content-Disposition": f"attachment; filename=axdio-{u}-data-{time.strftime('%Y%m%d')}.json"})

@app.route("/api/user/delete_account", methods=["POST"])
def user_delete_account():
    u = _me()
    pw = (request.get_json(silent=True) or {}).get("password") or ""
    with users_lock:
        if not verify_pw(pw, users_data[u].get("password", "")):
            return jsonify({"error": "That password isn't right."}), 400
    social_forget(u)
    with users_lock:
        drop_avatar_file(users_data[u])
        del users_data[u]
        save_users()
    session.pop("user", None); session.pop("epoch", None)
    activity("account", f"{u} deleted their account", u, "warn")
    return jsonify({"ok": True})

# --- Invites ---
INVITES_FILE = CONFIG_DIR / "invites.json"
_invites_lock = threading.RLock()

def load_invites():
    try:
        with open(INVITES_FILE, "r", encoding="utf-8") as f: return json.load(f)
    except Exception: return {}

def save_invites(inv):
    tmp = INVITES_FILE.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f: json.dump(inv, f, indent=2)
    os.replace(tmp, INVITES_FILE)

def invite_state(inv):
    if inv.get("revoked"): return "revoked"
    if inv.get("expires") and time.time() > inv["expires"]: return "expired"
    if inv.get("max_uses") and inv.get("uses", 0) >= inv["max_uses"]: return "used"
    return "active"

def base_url():
    c = cfg()
    if c.get("public_url"): return c["public_url"].rstrip("/")
    if c.get("trust_proxy", True):
        proto = request.headers.get("X-Forwarded-Proto", request.scheme).split(",")[0].strip()
        host = request.headers.get("X-Forwarded-Host", request.host).split(",")[0].strip()
        return f"{proto}://{host}"
    return request.host_url.rstrip("/")

# --- Failed-login lockout ---
_login_fails = {}
_login_fails_lock = threading.Lock()
LOCKOUT_SECONDS = 15 * 60

def login_locked(ip):
    with _login_fails_lock:
        now = time.time()
        fails = [t for t in _login_fails.get(ip, []) if now - t < LOCKOUT_SECONDS]
        _login_fails[ip] = fails
        return len(fails) >= int(cfg().get("login_max_attempts") or 10)

def login_failed(ip, who, where):
    with _login_fails_lock:
        _login_fails.setdefault(ip, []).append(time.time())
        n = len(_login_fails[ip])
    activity("login_failed", f"Failed {where} login", who, "warn")
    if n == int(cfg().get("login_max_attempts") or 10):
        activity("lockout", f"Locked out {ip} for 15 minutes after {n} failed logins", who, "error")
        notify("login_lockout", "Login lockout", f"{n} failed {where} logins from `{ip}` (last username tried: `{who}`). Blocked for 15 minutes.", 15548997)

def login_succeeded(ip):
    with _login_fails_lock: _login_fails.pop(ip, None)

LOCKED_MSG = "Too many failed logins. Try again in 15 minutes."

# --- Public config for the apps ---
def get_public_settings():
    c = cfg()
    out = {k: c.get(k) for k in ("site_title", "accent_color", "custom_css", "allow_indexing", "custom_favicon_url",
                                  "custom_logo_url", "app_version", "site_tagline", "meta_description", "public_url",
                                  "registration", "require_login", "min_password_length") if c.get(k) is not None}
    out["features"] = {k: bool(c.get("feature_" + k, True)) for k in ("lyrics", "offline", "connect", "sharing", "transcoding", "subsonic", "scrobbling", "avatars", "social")}
    out["features"].update(chat=chat_on(), collab=collab_on(), discord_login=discord_login_ready(), discord_presence=discord_presence_ready(), party=party_on(),
                           rewind=rewind_on(), smart=smart_on(), daily=daily_on(), discover=discover_on(), achievements=achievements_on(), notes=notes_on(), chart=chart_on(), capsule=capsule_on())
    if chat_on():
        out["chat_media"] = {k: bool(c.get(key, True)) for k, key in MEDIA_KINDS.items()}
        out["chat_media"].update(max=media_max(), chunk=CHAT_CHUNK)
    out["defaults"] = {"crossfade": c.get("default_crossfade", 0), "gapless": c.get("default_gapless", True), "normalize": c.get("default_normalize", False)}
    text = (c.get("announcement_text") or "").strip()
    if text:
        out["announcement"] = {"text": text, "level": c.get("announcement_level", "info"),
                               "id": hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]}
    out["app_version"] = AXDIO_VERSION
    out["credit"] = AXDIO_CREDIT
    return out

@app.route("/api/branding")
def api_branding():
    user = get_current_user()
    return jsonify({"settings": get_public_settings(),
                    "viewer": {"authenticated": bool(user), "admin": bool(session.get("is_admin"))}})

# --- Request gates: maintenance, private server, feature switches ---
_OPEN_PREFIXES = ("/admin", "/api/admin/", "/api/auth/", "/api/branding", "/api/app-icon", "/api/health", "/metrics", "/rest/", "/web/", "/favicon.ico",
                  "/manifest.json", "/robots.txt", "/api/federation/", "/api/presence")
_PAGE_PATHS = {"/", "/offline", "/history", "/artists", "/albums", "/liked", "/playlist", "/profile", "/settings", "/messages", "/friends", "/user",
               "/mobile", "/mobile.html"}

def _maintenance_page(c):
    accent = c.get("accent_color") or "#22c55e"
    title = str(c.get("site_title") or "Axdio")
    msg = str(c.get("maintenance_message") or "")
    e = lambda s: s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
    html = f"""<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>{e(title)} · Maintenance</title><link rel="icon" href="/favicon.ico">
<style>body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0a0a;color:#fff;font:15px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;padding:24px;box-sizing:border-box}}
.c{{max-width:420px;text-align:center}}.d{{width:12px;height:12px;border-radius:50%;background:{e(accent)};margin:0 auto 20px;box-shadow:0 0 24px {e(accent)}}}
h1{{font-size:22px;margin:0 0 8px}}p{{color:#a3a3a3;margin:0}}a{{color:#737373;font-size:12px;text-decoration:none;display:inline-block;margin-top:32px}}</style></head>
<body><div class="c"><div class="d"></div><h1>{e(title)} is under maintenance</h1><p>{e(msg)}</p><a href="/admin">Admin sign-in</a></div></body></html>"""
    return Response(html, status=503, mimetype="text/html", headers={"Retry-After": "600", "Cache-Control": "no-store"})

@app.before_request
def admin_v2_gates():
    c = cfg()
    p = request.path
    is_admin = bool(session.get("is_admin"))
    # <audio> and <img> can't send the token header, so a token-authenticated API call
    # (re)issues the session cookie those requests rely on.
    if request.headers.get("X-Auth-Token"):
        u = get_current_user()
        if u:
            with users_lock:
                if session.get("user") != u or session.get("epoch", 0) != users_data[u].get("session_epoch", 0):
                    _start_user_session(u)
    if is_admin or p.startswith(_OPEN_PREFIXES): pass
    elif c.get("maintenance_mode"):
        if p in _PAGE_PATHS or not p.startswith("/api/"): return _maintenance_page(c)
        return jsonify({"error": "The server is under maintenance.", "maintenance": True}), 503
    elif c.get("require_login") and p.startswith("/api/") and p != "/api/user/sync" and not get_current_user():
        return jsonify({"error": "Sign in to use this server.", "login_required": True}), 401
    if not c.get("feature_lyrics", True) and p == "/api/lyrics":
        return jsonify({"synced": None, "plain": None, "disabled": True})
    if p.startswith(("/api/social/", "/api/chat/")):
        if not c.get("feature_social", True): return jsonify({"error": "Friends and messages are turned off on this server.", "disabled": True}), 403
        if p.startswith("/api/chat/") and not c.get("feature_chat", True): return jsonify({"error": "Messages are turned off on this server.", "disabled": True}), 403
        if p.startswith("/api/social/playlists") and not c.get("feature_collab", True):
            return jsonify({"error": "Collaborative playlists are turned off on this server.", "disabled": True}), 403
    if p.startswith("/api/party") and not c.get("feature_party", True):
        return jsonify({"error": "Listening parties are turned off on this server.", "disabled": True}), 403
    if p.startswith("/api/timecapsule") and not c.get("feature_capsule", True):
        return jsonify({"error": "The time capsule is turned off on this server.", "disabled": True}), 403
    if p.startswith("/api/achievements") and not c.get("feature_achievements", True):
        return jsonify({"error": "Achievements are turned off on this server.", "disabled": True}), 403
    if p.startswith("/api/discover") and not c.get("feature_discover", True):
        return jsonify({"error": "Discover is turned off on this server.", "disabled": True}), 403
    if p.startswith("/api/daily") and not c.get("feature_daily", True):
        return jsonify({"error": "Axdio Daily is turned off on this server.", "disabled": True}), 403
    if p.startswith("/api/rewind") and not c.get("feature_rewind", True):
        return jsonify({"error": "Rewind is turned off on this server.", "disabled": True}), 403
    if not c.get("feature_connect", True) and p.startswith("/api/devices/"):
        return jsonify({"error": "Connect is turned off on this server.", "devices": []}), 403

def _inject_head(resp):
    # Admin-provided <head> snippet goes into app pages only, never the admin panel.
    try:
        snippet = cfg().get("custom_head") or ""
        if (snippet and resp.status_code == 200 and resp.mimetype == "text/html"
                and (request.path in _PAGE_PATHS or _SHARE_PAGE.fullmatch(request.path))):
            resp.direct_passthrough = False
            body = resp.get_data(as_text=True)
            if "</head>" in body:
                resp.set_data(body.replace("</head>", snippet + "\n</head>", 1))
                resp.headers.pop("ETag", None); resp.headers.pop("Last-Modified", None)
                resp.headers["Cache-Control"] = "no-cache"
    except Exception as ex:
        print(f"[WARN] custom <head> injection skipped: {ex}")
    return resp

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "SAMEORIGIN",
    "Permissions-Policy": "camera=(), microphone=(self), geolocation=(), payment=()",   # the microphone is for voice messages
    "Content-Security-Policy": "frame-ancestors 'self'; base-uri 'self'; object-src 'none'; form-action 'self'",
}
_GZIP_TYPES = ("text/", "application/json", "application/javascript", "application/manifest+json", "image/svg+xml")
_gzip_library = {"key": None, "body": b""}

_request_counts = collections.Counter()

_ASSET_RE = re.compile(r"""(/web/[A-Za-z0-9_./-]+\.(?:js|css))(?:\?v=[^"'&\s)]*)?""")
_asset_stamps = {}

def _asset_stamp(path):
    f = SCRIPT_DIR / path.lstrip("/")
    try: st = f.stat()
    except OSError: return None
    key = (st.st_mtime_ns, st.st_size)
    hit = _asset_stamps.get(path)
    if hit and hit[0] == key: return hit[1]
    stamp = hashlib.md5(f"{AXDIO_VERSION}:{key}".encode()).hexdigest()[:10]
    _asset_stamps[path] = (key, stamp)
    return stamp

def _stamp_assets(resp):
    """Point /web/ scripts and stylesheets at their current version (?v=<stamp>), in pages and in the scripts that load
    other scripts. A new release or an edited file gets a new address; unchanged ones stay cached."""
    try:
        if resp.status_code != 200 or resp.mimetype not in ("text/html", "application/javascript", "text/javascript"): return resp
        if resp.mimetype != "text/html" and not request.path.startswith(("/web/desktop/", "/web/mobile/", "/web/app/")): return resp
        resp.direct_passthrough = False
        source = resp.response
        body = resp.get_data(as_text=True)
        if hasattr(source, "close"): source.close()          # the file behind a send_file response
        if "/web/" not in body: return resp
        new = _ASSET_RE.sub(lambda m: f"{m.group(1)}?v={_asset_stamp(m.group(1)) or AXDIO_VERSION}", body)
        if new != body:
            resp.set_data(new)
            resp.headers.pop("Last-Modified", None)
            resp.set_etag(hashlib.md5(new.encode()).hexdigest())
            resp.make_conditional(request)
    except Exception as ex:
        print(f"[WARN] asset versioning skipped: {ex}")
    return resp

@app.after_request
def finish_response(resp):
    _request_counts[f"{resp.status_code // 100}xx"] += 1
    resp = _inject_head(resp)
    resp = _stamp_assets(resp)
    for k, v in SECURITY_HEADERS.items(): resp.headers.setdefault(k, v)
    if cfg().get("force_ssl") and (request.is_secure or request.headers.get("X-Forwarded-Proto") == "https"):
        resp.headers.setdefault("Strict-Transport-Security", "max-age=31536000")
    # gzip text responses (the 4-5 MB library index shrinks ~8x); audio and images pass through untouched.
    try:
        if (resp.status_code == 200 and "gzip" in request.headers.get("Accept-Encoding", "")
                and not resp.headers.get("Content-Encoding") and (resp.mimetype or "").startswith(_GZIP_TYPES)):
            if request.path == "/api/library/cache":
                key = (library_version, _cfg_state["mtime"])
                if _gzip_library["key"] != key:
                    _gzip_library.update(key=key, body=gzip.compress(resp.get_data(), 6))
                body = _gzip_library["body"]
            else:
                resp.direct_passthrough = False
                raw = resp.get_data()
                body = gzip.compress(raw, 6) if len(raw) > 1024 else None
            if body is not None:
                resp.set_data(body)
                resp.headers["Content-Encoding"] = "gzip"
                resp.vary.add("Accept-Encoding")
                etag = resp.headers.get("ETag")
                if etag and not etag.startswith("W/"): resp.headers["ETag"] = "W/" + etag
    except Exception as ex:
        print(f"[WARN] gzip skipped for {request.path}: {ex}")
    return resp

@app.route("/metrics")
def prometheus_metrics():
    token = cfg().get("metrics_token") or ""
    given = (request.headers.get("Authorization") or "").removeprefix("Bearer ").strip()
    if not token or not hmac.compare_digest(given.encode(), token.encode()): abort(404)
    now = time.time()
    with listeners_lock: active = sum(1 for v in listeners.values() if now - v.get("last_seen", 0) < 300)
    with users_lock: n_users = len(users_data)
    with library_cache_lock: n_tracks, n_artists = len(library_cache_data), len(cached_prebuilt_tree)
    lines = [
        ("axdio_info", "Server version", "gauge", [(f'{{version="{AXDIO_VERSION}"}}', 1)]),
        ("axdio_uptime_seconds", "Seconds since the server started", "gauge", [("", int(now - SERVER_START_TIME))]),
        ("axdio_library_tracks", "Songs in the library", "gauge", [("", n_tracks)]),
        ("axdio_library_artists", "Artists in the library", "gauge", [("", n_artists)]),
        ("axdio_accounts", "Accounts", "gauge", [("", n_users)]),
        ("axdio_listeners_active", "Clients that streamed in the last 5 minutes", "gauge", [("", active)]),
        ("axdio_transcodes_running", "Data saver encodes in progress", "gauge", [("", len(_tc_jobs))]),
        ("axdio_scan_running", "1 while a library scan runs", "gauge", [("", int(SCAN["running"]))]),
        ("axdio_scan_last_timestamp_seconds", "When the last library scan finished", "gauge", [("", int(SCAN["last"] or 0))]),
        ("axdio_scan_duration_seconds", "How long the last library scan took", "gauge", [("", SCAN["took"] or 0)]),
        ("axdio_http_responses_total", "HTTP responses by status class", "counter",
         [(f'{{code="{k}"}}', v) for k, v in sorted(_request_counts.items())]),
    ]
    out = []
    for name, help_text, kind, samples in lines:
        out += [f"# HELP {name} {help_text}", f"# TYPE {name} {kind}"] + [f"{name}{labels} {value}" for labels, value in samples]
    return Response("\n".join(out) + "\n", mimetype="text/plain; version=0.0.4")

@app.route("/api/health")
def api_health():
    # For Docker HEALTHCHECK and uptime monitors: no auth, nothing sensitive.
    return jsonify({"status": "ok", "version": AXDIO_VERSION, "uptime": int(time.time() - SERVER_START_TIME),
                    "tracks": cached_prebuilt_count, "scanning": SCAN["running"]})

PREVIEW_BOTS = ("Twitterbot", "facebookexternalhit", "Discordbot", "Slackbot-LinkExpanding", "TelegramBot", "LinkedInBot",
                "WhatsApp", "Applebot", "redditbot", "Mastodon", "Iframely", "Embedly")

@app.route("/robots.txt")
def robots_txt():
    c = cfg()
    body = "User-agent: *\nDisallow: /admin\nDisallow: /api/\n" if c.get("allow_indexing") else "User-agent: *\nDisallow: /\n"
    if c.get("feature_sharing", True) and not c.get("allow_indexing"):
        body = "".join(f"User-agent: {b}\n" for b in PREVIEW_BOTS) + "Allow: /track/\nAllow: /album/\nAllow: /artist/\nDisallow: /\n\n" + body
    return Response(body, mimetype="text/plain")

# --- Accounts: sign-up and login ---
@app.route("/api/auth/register", methods=["POST"])
def auth_register():
    c = cfg()
    ip = client_ip()
    if login_locked(ip): return jsonify({"error": LOCKED_MSG}), 429
    mode = c.get("registration", "open")
    if mode == "closed":
        return jsonify({"error": "Sign-ups are closed on this server. Ask the admin for an account."}), 403
    data = request.json or {}
    username = (data.get("username") or "").strip().lower()
    password = data.get("password") or ""
    display_name = (data.get("display_name") or username).strip()[:32] or username
    if not USERNAME_RE.match(username):
        return jsonify({"error": "Usernames are 2–32 characters: letters, numbers, dots, dashes or underscores."}), 400
    err = _check_password(password)
    if err: return jsonify({"error": err}), 400
    code = (data.get("invite_code") or "").strip().upper()
    with _invites_lock:
        invites = load_invites()
        inv = invites.get(code) if code else None
        if mode == "invite" and (not inv or invite_state(inv) != "active"):
            return jsonify({"error": "A valid invite code is required to sign up.", "invite_required": True}), 403
        with users_lock:
            if username in users_data: return jsonify({"error": "That username is taken."}), 400
            users_data[username] = _new_user_record(password, display_name)
            token = issue_token(users_data[username])
            users_data[username]["last_login"] = datetime.now().isoformat()
            if inv:
                users_data[username]["invited_with"] = code
            save_users()
            _start_user_session(username)
        if inv and invite_state(inv) == "active":
            inv["uses"] = inv.get("uses", 0) + 1
            inv.setdefault("used_by", []).append(username)
            save_invites(invites)
    activity("register", f"New account{' with invite ' + code if inv else ''}", username)
    notify("user_registered", "New account", f"**{display_name}** (`{username}`) signed up on {c.get('site_title', 'Axdio')}.")
    return jsonify({"success": True, "username": username, "display_name": display_name, "token": token})

@app.route("/api/auth/login", methods=["POST"])
def auth_login():
    ip = client_ip()
    if login_locked(ip): return jsonify({"error": LOCKED_MSG}), 429
    data = request.json or {}
    username = (data.get("username") or "").strip().lower()
    password = data.get("password") or ""
    with users_lock:
        rec = users_data.get(username)
        ok = bool(rec) and verify_pw(password, rec.get("password", ""))
        if ok and rec.get("disabled"):
            return jsonify({"error": "This account has been disabled. Contact the server admin."}), 403
        if ok:
            token = issue_token(rec)
            rec["last_login"] = datetime.now().isoformat()
            save_users(username)
            _start_user_session(username)
    if not ok:
        login_failed(ip, username, "app")
        return jsonify({"error": "Invalid username or password"}), 401
    login_succeeded(ip)
    return jsonify({"success": True, "username": username, "display_name": rec.get("display_name", username),
                    "avatar": rec.get("avatar", ""), "token": token, "is_admin": bool(rec.get("is_admin"))})

# --- Two-factor authentication (TOTP, RFC 6238) for admin sign-in ---
def totp_code(secret, step):
    key = base64.b32decode(secret + "=" * (-len(secret) % 8), casefold=True)
    h = hmac.new(key, step.to_bytes(8, "big"), hashlib.sha1).digest()
    o = h[-1] & 0x0F
    return str((int.from_bytes(h[o:o + 4], "big") & 0x7FFFFFFF) % 1000000).zfill(6)

def totp_verify(secret, code, last_step=0):
    """The time step the code belongs to (±30 s allowed), or None. Codes can't be used twice."""
    code = re.sub(r"\s", "", str(code or ""))
    if not re.fullmatch(r"\d{6}", code): return None
    now = int(time.time() // 30)
    for step in (now - 1, now, now + 1):
        if step > (last_step or 0) and hmac.compare_digest(totp_code(secret, step), code): return step
    return None

def admin_totp(who, kind):
    """(secret, last_step) for an admin identity, or (None, 0)."""
    if kind == "builtin":
        t = cfg().get("admin_totp") or {}
    else:
        with users_lock: t = (users_data.get(who) or {}).get("totp") or {}
    return t.get("secret"), t.get("last", 0)

def set_admin_totp(who, kind, data):
    if kind == "builtin":
        cfg_save({"admin_totp": data})
    else:
        with users_lock:
            rec = users_data.get(who)
            if rec is None: return
            if data: rec["totp"] = data
            else: rec.pop("totp", None)
            save_users(who)

def _finish_admin_login(who, kind, ip):
    login_succeeded(ip)
    session.pop("pending_admin", None)
    session["is_admin"] = True
    session["admin_user"] = who
    session["admin_kind"] = kind
    session.permanent = True
    activity("admin_login", "Signed in to the admin panel", who)
    return redirect("/admin")

@app.route("/admin/login", methods=["GET", "POST"])
def admin_login_page():
    c = cfg()
    if not c.get("admin_user") or not c.get("admin_password"):
        return redirect(url_for("admin_setup_page"))
    error = None
    pending = session.get("pending_admin")
    if pending and pending.get("until", 0) < time.time():
        session.pop("pending_admin", None); pending = None
    if request.method == "POST":
        ip = client_ip()
        if login_locked(ip):
            error = LOCKED_MSG
        elif pending:
            secret, last = admin_totp(pending["who"], pending["kind"])
            step = totp_verify(secret, request.form.get("code"), last) if secret else None
            if step:
                set_admin_totp(pending["who"], pending["kind"], {"secret": secret, "last": step})
                return _finish_admin_login(pending["who"], pending["kind"], ip)
            login_failed(ip, pending["who"], "admin 2FA")
            error = "That code didn't work. Codes change every 30 seconds."
        else:
            u, p = request.form.get("username", "").strip(), request.form.get("password", "")
            who = kind = None
            if hmac.compare_digest(u.encode(), str(c.get("admin_user")).encode()) and verify_pw(p, c.get("admin_password")):
                who, kind = u, "builtin"
            else:
                with users_lock:
                    rec = users_data.get(u.lower())
                    if rec and rec.get("is_admin") and not rec.get("disabled") and verify_pw(p, rec.get("password", "")):
                        who, kind = u.lower(), "user"
            if who:
                if admin_totp(who, kind)[0]:
                    session["pending_admin"] = {"who": who, "kind": kind, "until": time.time() + 300}
                    return render_template("admin_login.html", settings=c, error=None, is_setup=False, need_code=True)
                return _finish_admin_login(who, kind, ip)
            login_failed(ip, u, "admin")
            error = "Invalid administrator credentials."
    return render_template("admin_login.html", settings=c, error=error, is_setup=False, need_code=bool(session.get("pending_admin")))

@app.route("/admin/logout")
def admin_logout():
    if session.get("is_admin"): activity("admin_logout", "Signed out of the admin panel", admin_name())
    for k in ("is_admin", "admin_user", "admin_kind", "pending_admin", "totp_setup"): session.pop(k, None)
    return redirect("/")

@app.route("/admin")
@app.route("/admin.html")
def admin_dashboard():
    c = cfg()
    if not c.get("admin_user") or not c.get("admin_password"): return redirect(url_for("admin_setup_page"))
    if not session.get("is_admin"): return redirect(url_for("admin_login_page"))
    resp = send_file(str(SCRIPT_DIR / "web" / "admin" / "index.html"), mimetype="text/html")
    resp.headers["Cache-Control"] = "no-store"
    return resp

# --- Admin API ---
def _json():
    return request.get_json(silent=True) or {}

def _int(v, lo, hi):
    try: return max(lo, min(hi, int(v or 0)))
    except (TypeError, ValueError): return lo

@app.route("/api/admin/v2/me")
def av2_me():
    c = cfg()
    return jsonify({"admin_user": admin_name(), "site_title": c.get("site_title"), "accent_color": c.get("accent_color"),
                    "app_version": AXDIO_VERSION, "credit": AXDIO_CREDIT})

@app.route("/api/admin/v2/config", methods=["GET", "POST"])
def av2_config():
    if request.method == "POST":
        values = _json().get("values") or {}
        updates, errors = {}, {}
        for k, v in values.items():
            f = SCHEMA_FIELDS.get(k)
            if not f: continue
            try: updates[k] = _coerce(f, v)
            except ValueError as ex: errors[k] = str(ex)
        if errors: return jsonify({"error": next(iter(errors.values())), "fields": errors}), 400
        before = cfg()
        changed = [k for k, v in updates.items() if before.get(k) != v]
        cfg_save(updates)
        if changed:
            activity("settings", "Changed " + ", ".join(SCHEMA_FIELDS[k]["label"] for k in changed), admin_name())
        return jsonify({"ok": True, "changed": changed, "values": {k: cfg().get(k) for k in SCHEMA_FIELDS}})
    c = cfg()
    return jsonify({"schema": ADMIN_SCHEMA, "values": {k: c.get(k) for k in SCHEMA_FIELDS}})

def _admin_identity():
    who = session.get("admin_user") or cfg().get("admin_user")
    kind = session.get("admin_kind") or ("builtin" if who == cfg().get("admin_user") else "user")
    return who, kind

@app.route("/api/admin/v2/2fa", methods=["GET", "POST"])
def av2_2fa():
    who, kind = _admin_identity()
    if request.method == "POST":
        d = _json()
        action = d.get("action")
        if action == "start":
            secret = base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")
            session["totp_setup"] = secret
            label = urllib.parse.quote(f"{cfg().get('site_title', 'Axdio')}:{who}")
            uri = f"otpauth://totp/{label}?secret={secret}&issuer={urllib.parse.quote(cfg().get('site_title', 'Axdio'))}"
            return jsonify({"secret": secret, "uri": uri})
        if action == "confirm":
            secret = session.get("totp_setup")
            step = totp_verify(secret, d.get("code")) if secret else None
            if not step: return jsonify({"error": "That code didn't match. Check the time on your phone and try again."}), 400
            set_admin_totp(who, kind, {"secret": secret, "last": step})
            session.pop("totp_setup", None)
            activity("admin_account", "Turned on two-factor sign-in", who)
        elif action == "disable":
            secret, last = admin_totp(who, kind)
            if not secret or not totp_verify(secret, d.get("code"), last):
                return jsonify({"error": "Enter a current code from your authenticator app to turn this off."}), 400
            set_admin_totp(who, kind, None)
            activity("admin_account", "Turned off two-factor sign-in", who, "warn")
        else:
            return jsonify({"error": "Unknown action."}), 400
    return jsonify({"enabled": bool(admin_totp(who, kind)[0]), "who": who})

@app.route("/api/admin/v2/admin_account", methods=["POST"])
def av2_admin_account():
    d = _json()
    c = cfg()
    if not verify_pw(d.get("current_password") or "", c.get("admin_password")):
        return jsonify({"error": "Your current password is incorrect."}), 400
    updates = {}
    new_user = (d.get("username") or "").strip()
    if new_user and new_user != c.get("admin_user"): updates["admin_user"] = new_user
    new_pw = d.get("new_password") or ""
    if new_pw:
        if len(new_pw) < 8: return jsonify({"error": "Use at least 8 characters for the admin password."}), 400
        updates["admin_password"] = hash_pw(new_pw)
    if not updates: return jsonify({"error": "Nothing to change."}), 400
    cfg_save(updates)
    if "admin_user" in updates and session.get("admin_user") == c.get("admin_user"): session["admin_user"] = updates["admin_user"]
    activity("admin_account", "Changed the admin " + " and ".join(x for x, k in (("username", "admin_user"), ("password", "admin_password")) if k in updates), admin_name())
    return jsonify({"ok": True})

# Uploads: logo (any web image), favicon (PNG/ICO), app icon (PNG, shown on home screens and media notifications).
def _sniff_image(data):
    if data[:8] == b"\x89PNG\r\n\x1a\n": return ".png", "image/png"
    if data[:3] == b"\xff\xd8\xff": return ".jpg", "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP": return ".webp", "image/webp"
    if data[:4] == b"\x00\x00\x01\x00": return ".ico", "image/x-icon"
    head = data[:512].lstrip().lower()
    if head.startswith(b"<svg") or (head.startswith(b"<?xml") and b"<svg" in data[:2048].lower()): return ".svg", "image/svg+xml"
    return None, None

UPLOAD_KINDS = {
    "logo": {"exts": {".png", ".jpg", ".webp", ".svg"}, "max": 2 * 1024 * 1024},
    "favicon": {"exts": {".png", ".ico"}, "max": 512 * 1024},
    "app_icon": {"exts": {".png"}, "max": 2 * 1024 * 1024},
}

@app.route("/api/admin/v2/upload/<kind>", methods=["POST"])
def av2_upload(kind):
    spec = UPLOAD_KINDS.get(kind)
    if not spec: return jsonify({"error": "Unknown upload."}), 404
    f = request.files.get("file")
    if not f: return jsonify({"error": "No file received."}), 400
    data = f.read(spec["max"] + 1)
    if len(data) > spec["max"]: return jsonify({"error": f"That file is over {spec['max'] // 1024} KB."}), 400
    ext, _ = _sniff_image(data)
    if ext not in spec["exts"]:
        return jsonify({"error": "Use a " + ", ".join(sorted(e.lstrip(".").upper() for e in spec["exts"])) + " file."}), 400
    v = str(int(time.time()))
    if kind == "logo":
        for old in CONFIG_DIR.glob("custom_logo.*"): old.unlink(missing_ok=True)
        (CONFIG_DIR / f"custom_logo{ext}").write_bytes(data)
        cfg_save({"custom_logo_url": "/api/branding/logo?v=" + v})
    elif kind == "favicon":
        FAVICON_FILE.write_bytes(data)
        cfg_save({"custom_favicon_url": "/favicon.ico?v=" + v})
    else:
        PWA_ICON_FILE.write_bytes(data)
        cfg_save({"app_icon_version": v})
    activity("branding", f"Uploaded a new {kind.replace('_', ' ')}", admin_name())
    return jsonify({"ok": True, "url": {"logo": "/api/branding/logo", "favicon": "/favicon.ico", "app_icon": "/api/app-icon"}[kind] + "?v=" + v})

@app.route("/api/admin/v2/upload/<kind>/delete", methods=["POST"])
def av2_upload_delete(kind):
    if kind == "logo":
        for old in CONFIG_DIR.glob("custom_logo.*"): old.unlink(missing_ok=True)
        cfg_save({"custom_logo_url": ""})
    elif kind == "favicon":
        FAVICON_FILE.unlink(missing_ok=True)
        cfg_save({"custom_favicon_url": ""})
    elif kind == "app_icon":
        PWA_ICON_FILE.unlink(missing_ok=True)
        cfg_save({"app_icon_version": ""})
    else: return jsonify({"error": "Unknown upload."}), 404
    activity("branding", f"Removed the custom {kind.replace('_', ' ')}", admin_name())
    return jsonify({"ok": True})

def branding_assets():
    logo = next(iter(sorted(CONFIG_DIR.glob("custom_logo.*"))), None)
    return {"logo": "/api/branding/logo?v=" + str(int(logo.stat().st_mtime)) if logo else "",
            "favicon": "/favicon.ico?v=" + str(int(FAVICON_FILE.stat().st_mtime)) if FAVICON_FILE.exists() else "",
            "app_icon": "/api/app-icon?v=" + str(int(PWA_ICON_FILE.stat().st_mtime)) if PWA_ICON_FILE.exists() else ""}

@app.route("/api/branding/logo")
def serve_custom_logo():
    logo = next(iter(sorted(CONFIG_DIR.glob("custom_logo.*"))), None)
    if not logo: abort(404)
    resp = send_file(str(logo), mimetype=_sniff_image(logo.read_bytes()[:2048])[1] or "application/octet-stream", max_age=86400)
    # An SVG is a document: never let it run scripts on this origin.
    resp.headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; img-src data:"
    return resp

@app.route("/api/admin/v2/branding")
def av2_branding():
    return jsonify(branding_assets())

# Users
def _user_row(u, rec):
    hist = rec.get("history", [])
    last_played = max((h.get("last_played") or "" for h in hist), default="")
    return {"username": u, "display_name": rec.get("display_name") or u, "avatar": rec.get("avatar", ""),
            "created": rec.get("created", ""), "last_login": rec.get("last_login", ""), "last_played": last_played,
            "is_admin": bool(rec.get("is_admin")), "disabled": bool(rec.get("disabled")), "devices": len(rec.get("tokens", [])),
            "liked": len(rec.get("liked_songs", [])), "playlists": len(rec.get("playlists", {})),
            "plays": sum(h.get("count", 1) for h in hist), "invited_with": rec.get("invited_with", "")}

@app.route("/api/admin/v2/users", methods=["GET", "POST"])
def av2_users():
    if request.method == "POST":
        d = _json()
        username = (d.get("username") or "").strip().lower()
        password = d.get("password") or ""
        if not USERNAME_RE.match(username):
            return jsonify({"error": "Usernames are 2–32 characters: letters, numbers, dots, dashes or underscores."}), 400
        err = _check_password(password)
        if err: return jsonify({"error": err}), 400
        with users_lock:
            if username in users_data: return jsonify({"error": "That username is taken."}), 400
            users_data[username] = _new_user_record(password, (d.get("display_name") or username).strip()[:32], d.get("is_admin"))
            save_users()
            row = _user_row(username, users_data[username])
        activity("user", f"Created account {username}" + (" (admin)" if d.get("is_admin") else ""), admin_name())
        return jsonify({"ok": True, "user": row})
    with users_lock:
        rows = [_user_row(u, rec) for u, rec in users_data.items()]
    rows.sort(key=lambda r: r["created"] or "", reverse=True)
    return jsonify({"users": rows})

@app.route("/api/admin/v2/users/<username>/<action>", methods=["POST"])
def av2_user_action(username, action):
    d = _json()
    me = admin_name()
    if action == "delete" and username != me and username in users_data: social_forget(username)
    with users_lock:
        rec = users_data.get(username)
        if not rec: return jsonify({"error": "No such user."}), 404
        if action == "update":
            changes = []
            if "display_name" in d:
                rec["display_name"] = str(d["display_name"]).strip()[:32] or username; changes.append("renamed")
            if "is_admin" in d:
                if not d["is_admin"] and username == me: return jsonify({"error": "You can't remove your own admin access."}), 400
                rec["is_admin"] = bool(d["is_admin"]); changes.append("admin " + ("granted" if d["is_admin"] else "removed"))
            if "disabled" in d:
                if d["disabled"] and username == me: return jsonify({"error": "You can't disable your own account."}), 400
                rec["disabled"] = bool(d["disabled"]); changes.append("disabled" if d["disabled"] else "enabled")
                if d["disabled"]: _revoke_sessions(rec)
            msg = f"{username}: " + ", ".join(changes)
        elif action == "password":
            pw = d.get("password") or ""
            err = _check_password(pw)
            if err: return jsonify({"error": err}), 400
            rec["password"] = hash_pw(pw)
            _revoke_sessions(rec)
            msg = f"Reset the password for {username} and signed them out everywhere"
        elif action == "signout":
            _revoke_sessions(rec)
            msg = f"Signed {username} out on every device"
        elif action == "remove_avatar":
            drop_avatar_file(rec)
            rec["avatar"] = ""
            msg = f"Removed the profile photo of {username}"
        elif action == "delete":
            if username == me: return jsonify({"error": "You can't delete the account you're signed in with."}), 400
            drop_avatar_file(rec)
            del users_data[username]
            save_users()
            activity("user", f"Deleted account {username}", me, "warn")
            return jsonify({"ok": True})
        else: return jsonify({"error": "Unknown action."}), 404
        save_users()
        row = _user_row(username, rec)
    activity("user", msg, me)
    return jsonify({"ok": True, "user": row})

# Invites
@app.route("/api/admin/v2/invites", methods=["GET", "POST"])
def av2_invites():
    with _invites_lock:
        invites = load_invites()
        if request.method == "POST":
            d = _json()
            code = f"{secrets.token_hex(2)}-{secrets.token_hex(2)}".upper()
            days = _int(d.get("expires_days"), 0, 365)
            invites[code] = {"created": time.time(), "created_by": admin_name(), "note": str(d.get("note") or "")[:80],
                             "max_uses": _int(d.get("max_uses"), 0, 1000),
                             "expires": time.time() + days * 86400 if days else 0, "uses": 0, "used_by": []}
            save_invites(invites)
            activity("invite", f"Created invite {code}" + (f" ({invites[code]['note']})" if invites[code]["note"] else ""), admin_name())
        base = base_url()
        rows = [{**inv, "code": code, "state": invite_state(inv), "link": f"{base}/?invite={code}"} for code, inv in invites.items()]
    rows.sort(key=lambda r: r.get("created", 0), reverse=True)
    return jsonify({"invites": rows, "registration": cfg().get("registration", "open")})

@app.route("/api/admin/v2/invites/<code>/revoke", methods=["POST"])
def av2_invite_revoke(code):
    with _invites_lock:
        invites = load_invites()
        if code not in invites: return jsonify({"error": "No such invite."}), 404
        if invites[code].get("uses"): invites[code]["revoked"] = True
        else: del invites[code]
        save_invites(invites)
    activity("invite", f"Revoked invite {code}", admin_name())
    return jsonify({"ok": True})

# Overview, system, activity and logs
def _dir_size(path):
    total, count = 0, 0
    try:
        for e in os.scandir(path):
            try:
                if e.is_file(follow_symlinks=False): total += e.stat().st_size; count += 1
                elif e.is_dir(follow_symlinks=False):
                    t, c = _dir_size(e.path); total += t; count += c
            except OSError: pass
    except OSError: pass
    return total, count

_ffmpeg_version = []
def ffmpeg_version():
    if not _ffmpeg_version:
        try:
            out = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True, timeout=5).stdout
            _ffmpeg_version.append(out.split("\n")[0].replace("ffmpeg version ", "").split(" ")[0])
        except Exception: _ffmpeg_version.append("")
    return _ffmpeg_version[0]

def _pkg_version(name):
    try: return importlib.metadata.version(name)
    except Exception: return ""

def _system_stats():
    mem_used = mem_total = 0
    try:
        with open("/proc/meminfo") as f:
            mi = {l.split(":")[0]: int(l.split(":")[1].split()[0]) for l in f if ":" in l}
        mem_total = mi.get("MemTotal", 0) // 1024
        mem_used = max(0, mem_total - mi.get("MemAvailable", 0) // 1024)
    except Exception: pass
    try:
        with open("/proc/loadavg") as f: load = [float(x) for x in f.read().split()[:3]]
    except Exception: load = [0, 0, 0]
    disks = {}
    for name, path in (("music", config.get("music_dir") or get_real_music_dir()), ("config", str(CONFIG_DIR))):
        try:
            u = shutil.disk_usage(path)
            disks[name] = {"path": path, "total": u.total, "used": u.used, "free": u.free}
        except Exception: pass
    return {"uptime": int(time.time() - SERVER_START_TIME), "load": load, "cpus": os.cpu_count() or 1,
            "mem_used_mb": mem_used, "mem_total_mb": mem_total, "disks": disks}

_overview_cache = {"t": 0, "caches": {}}

@app.route("/api/admin/v2/overview")
def av2_overview():
    with library_cache_lock:
        rels = list(library_cache_data.keys())
        tree = cached_prebuilt_tree
        formats = collections.Counter(Path(r).suffix.lower().lstrip(".") or "other" for r in rels)
        n_albums = sum(len(a.get("albums", [])) for a in tree)
        missing_art = sum(1 for v in library_cache_data.values() if isinstance(v, dict) and not v.get("has_cover"))
    plays, by_user = collections.Counter(), []
    with users_lock:
        n_users = len(users_data)
        n_admins = sum(1 for r in users_data.values() if r.get("is_admin"))
        for u, rec in users_data.items():
            total = 0
            for h in rec.get("history", []):
                c = h.get("count", 1); total += c
                if h.get("rel_path"): plays[h["rel_path"]] += c
            by_user.append({"username": u, "display_name": rec.get("display_name") or u, "plays": total})
    top_tracks = []
    with library_cache_lock:
        for rel, n in plays.most_common(8):
            meta = library_cache_data.get(rel) or {}
            top_tracks.append({"rel_path": rel, "plays": n, "title": meta.get("title") or Path(rel).stem, "artist": meta.get("artist") or ""})
    by_user.sort(key=lambda x: x["plays"], reverse=True)
    now = time.time()
    if now - _overview_cache["t"] > 120:
        _overview_cache["caches"] = {k: _dir_size(str(p)) for k, p in (("covers", COVERS_CACHE_DIR), ("lyrics", LYRICS_CACHE_DIR), ("quarantine", CONFIG_DIR / "quarantine"))}
        _overview_cache["t"] = now
    listening = []
    with listeners_lock:
        for v in list(listeners.values()):
            if now - v.get("last_seen", 0) < 300: listening.append(v)
    with _invites_lock:
        active_invites = sum(1 for inv in load_invites().values() if invite_state(inv) == "active")
    return jsonify({
        "library": {"tracks": len(rels), "artists": len(tree), "albums": n_albums, "formats": dict(formats.most_common()),
                    "missing_art": missing_art, "music_dir": config.get("music_dir") or get_real_music_dir()},
        "users": {"total": n_users, "admins": n_admins, "invites": active_invites, "top": by_user[:6]},
        "top_tracks": top_tracks, "listening": listening,
        "caches": {k: {"bytes": v[0], "files": v[1]} for k, v in _overview_cache["caches"].items()},
        "system": _system_stats(),
        "social": social_stats(),
        "activity": list(_activity)[-8:][::-1],
        "scan": dict(SCAN),
        "settings": {k: cfg().get(k) for k in ("registration", "require_login", "maintenance_mode", "force_ssl")},
    })

@app.route("/api/admin/v2/system")
def av2_system():
    c = cfg()
    return jsonify({
        "app_version": AXDIO_VERSION, "python": platform.python_version(), "platform": platform.platform(),
        "flask": _pkg_version("flask"), "plugins": {p["name"]: v for p in PLUGIN_CATALOG.values() if (v := plugin_versions().get(p["package"]))},
        "mutagen": _pkg_version("mutagen"), "ffmpeg": ffmpeg_version(), "music_dir": config.get("music_dir") or get_real_music_dir(),
        "config_dir": str(CONFIG_DIR), "secret_key_source": "environment" if os.environ.get("FLASK_SECRET_KEY") else "config/secret_key",
        "credit": AXDIO_CREDIT, "restart_available": "gunicorn" in sys.modules, "server": "gunicorn" if "gunicorn" in sys.modules else "development server",
        **_system_stats(),
    })

@app.route("/api/admin/v2/system/restart", methods=["POST"])
def av2_restart():
    # Gunicorn reloads its worker on SIGHUP: settings and code changes are picked up, the site stays up.
    if "gunicorn" not in sys.modules:
        return jsonify({"error": "Restart the container to apply changes (this server isn't running under gunicorn)."}), 400
    activity("system", "Restarted the server", admin_name(), "warn")
    threading.Timer(0.5, lambda: os.kill(os.getppid(), signal.SIGHUP)).start()
    return jsonify({"ok": True})

@app.route("/api/admin/v2/activity")
def av2_activity():
    kind = request.args.get("kind", "")
    items = [e for e in _activity if not kind or e.get("kind") == kind]
    return jsonify({"items": items[-500:][::-1]})

@app.route("/api/admin/v2/logs")
def av2_logs():
    since = int(request.args.get("since") or 0)
    with _log_lock:
        lines = [{"n": n, "t": t, "line": l} for n, t, l in _log_lines if n > since]
    return jsonify({"lines": lines[-1000:], "last": _log_seq[0]})

# Library & maintenance actions
@app.route("/api/admin/v2/library/scan", methods=["POST"])
def av2_library_scan():
    if SCAN["running"]: return jsonify({"ok": True, "running": True})
    _scan_now.set()
    activity("library", "Started a library scan", admin_name())
    return jsonify({"ok": True})

@app.route("/api/admin/v2/library/refresh", methods=["POST"])
def av2_library_refresh():
    rebuild_in_memory_tree()
    activity("library", "Rebuilt the library index", admin_name())
    return jsonify({"ok": True, "version": library_version})

@app.route("/api/admin/v2/cache/lyrics/clear", methods=["POST"])
def av2_clear_lyrics():
    n = 0
    for p in LYRICS_CACHE_DIR.glob("*.json"):
        try: p.unlink(); n += 1
        except OSError: pass
    _overview_cache["t"] = 0
    activity("maintenance", f"Cleared {n} cached lyrics", admin_name())
    return jsonify({"ok": True, "removed": n})

@app.route("/api/admin/v2/notify/test", methods=["POST"])
def av2_notify_test():
    c = cfg()
    if not c.get("discord_webhook") and not c.get("webhook_url"):
        return jsonify({"error": "Add a Discord or generic webhook URL first, then save."}), 400
    res = notify("test", "Test notification", f"Notifications from {c.get('site_title', 'Axdio')} are working.", wait=True)
    failed = [k for k, ok in res.items() if not ok]
    if failed: return jsonify({"error": "Couldn't reach: " + ", ".join(failed), "result": res}), 502
    return jsonify({"ok": True, "result": res})

# Backup & restore (settings, accounts with their likes/playlists/history, invites)
BACKUP_DIR = CONFIG_DIR / "backups"
BACKUP_NAME_RE = re.compile(r"^axdio-backup-\d{8}-\d{6}(-manual)?\.json\.gz$")

def backup_payload():
    with users_lock: users = json.loads(json.dumps(users_data))
    return {"format": "axdio-backup", "version": 2, "app_version": AXDIO_VERSION, "exported_at": datetime.now().isoformat(),
            "settings": dict(_cfg_state["raw"] or cfg()), "users": users, "invites": load_invites(), "shared_playlists": _pl_rows()}

def write_backup(manual=False):
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    name = f"axdio-backup-{time.strftime('%Y%m%d-%H%M%S')}{'-manual' if manual else ''}.json.gz"
    tmp = BACKUP_DIR / (name + ".tmp")
    with gzip.open(tmp, "wt", encoding="utf-8") as f: json.dump(backup_payload(), f)
    os.chmod(tmp, 0o600)
    tmp.rename(BACKUP_DIR / name)
    keep = int(cfg().get("backup_keep") or 7)
    autos = sorted(p for p in BACKUP_DIR.glob("axdio-backup-*.json.gz") if not p.name.endswith("-manual.json.gz"))
    for old in autos[:-keep]: old.unlink(missing_ok=True)
    return name

def list_backups():
    if not BACKUP_DIR.is_dir(): return []
    out = []
    for p in sorted(BACKUP_DIR.glob("axdio-backup-*.json.gz"), reverse=True):
        st = p.stat()
        out.append({"name": p.name, "size": st.st_size, "time": st.st_mtime, "manual": p.name.endswith("-manual.json.gz")})
    return out

def backup_scheduler():
    time.sleep(120)
    while True:
        try:
            every = {"daily": 86400, "weekly": 7 * 86400}.get(cfg().get("backup_schedule", "daily"))
            if every:
                autos = [b for b in list_backups() if not b["manual"]]
                if not autos or time.time() - autos[0]["time"] >= every - 300:
                    name = write_backup()
                    print(f"[INFO] Automatic backup saved: {name}")
        except Exception as ex:
            print(f"[ERROR] Automatic backup failed: {ex}")
        time.sleep(600)

@app.route("/api/admin/v2/backup")
def av2_backup():
    activity("backup", "Downloaded a backup", admin_name())
    name = re.sub(r"[^a-z0-9]+", "-", str(cfg().get("site_title") or "axdio").lower()).strip("-") or "axdio"
    return Response(json.dumps(backup_payload(), indent=2), mimetype="application/json",
                    headers={"Content-Disposition": f"attachment; filename={name}-backup-{time.strftime('%Y%m%d')}.json"})

@app.route("/api/admin/v2/backups", methods=["GET", "POST"])
def av2_backups():
    if request.method == "POST":
        name = write_backup(manual=True)
        activity("backup", f"Saved backup {name}", admin_name())
    return jsonify({"backups": list_backups(), "dir": str(BACKUP_DIR)})

@app.route("/api/admin/v2/backups/<name>", methods=["GET", "DELETE"])
def av2_backup_file(name):
    if not BACKUP_NAME_RE.match(name) or not (BACKUP_DIR / name).is_file(): return jsonify({"error": "No such backup."}), 404
    if request.method == "DELETE":
        (BACKUP_DIR / name).unlink()
        activity("backup", f"Deleted backup {name}", admin_name())
        return jsonify({"ok": True})
    return send_file(str(BACKUP_DIR / name), mimetype="application/gzip", as_attachment=True, download_name=name)

@app.route("/api/admin/v2/backups/<name>/restore", methods=["POST"])
def av2_backup_restore(name):
    if not BACKUP_NAME_RE.match(name) or not (BACKUP_DIR / name).is_file(): return jsonify({"error": "No such backup."}), 404
    with gzip.open(BACKUP_DIR / name, "rt", encoding="utf-8") as f: data = json.load(f)
    return restore_backup(data, request.args.get("parts", "settings,users,invites").split(","), name)

@app.route("/api/admin/v2/restore", methods=["POST"])
def av2_restore():
    return restore_backup(_json(), request.args.get("parts", "settings,users,invites").split(","), "an uploaded file")

def restore_backup(d, parts, source):
    if d.get("format") != "axdio-backup" and not ("settings" in d and "users" in d):
        return jsonify({"error": "That file isn't an Axdio backup."}), 400
    done = []
    if "settings" in parts and isinstance(d.get("settings"), dict):
        cfg_save(d["settings"]); done.append("settings")
    if "users" in parts and isinstance(d.get("users"), dict):
        with users_lock:
            users_data.clear(); users_data.update({u: _normalize_user(u, r) for u, r in d["users"].items() if isinstance(r, dict)})
            save_users()
        load_users(); done.append(f"{len(d['users'])} accounts")
        if isinstance(d.get("shared_playlists"), list):
            with SOCIAL_LOCK, _db_lock:
                db().execute("DELETE FROM shared_playlists")
                for pl in d["shared_playlists"]:
                    if isinstance(pl, dict) and PL_ID_RE.match(str(pl.get("id") or "")):
                        db().execute("INSERT INTO shared_playlists (id, data, updated) VALUES (?, ?, ?)", (pl["id"], json.dumps(pl), pl.get("updated") or time.time()))
            done.append(f"{len(d['shared_playlists'])} collaborative playlists")
    if "invites" in parts and isinstance(d.get("invites"), dict):
        with _invites_lock: save_invites(d["invites"])
        done.append("invites")
    activity("restore", "Restored " + ", ".join(done) + " from " + source, admin_name(), "warn")
    return jsonify({"ok": True, "restored": done})

# ============================================================
# SUBSONIC / OPENSUBSONIC API
# ============================================================
# Lets existing music apps (Symfonium, Feishin, DSub, Substreamer, play:Sub, Tempo, …) use this
# server at /rest/<method>[.view], answering in XML or JSON (f=json), Subsonic API 1.16.1 plus
# the OpenSubsonic formPost and songLyrics extensions.
#
# Sign-in: the account's username plus an app password made in the web app's Settings. Subsonic
# token auth (t = md5(password + s)) needs a password the server can read back, which the real
# password hash can't provide, so app passwords are stored encrypted with the server's secret key.
# Plain "p=" sign-in also accepts the real account password.
# Starring a song is the same as liking it in the web app; albums and artists have their own stars.
import xml.etree.ElementTree as ET

SUBSONIC_API_VERSION = "1.16.1"
SS_IGNORED_ARTICLES = "The El La Los Las Le Les"
_SS = {"version": None}
_ss_auth_cache = {}

class SSError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code, self.message = code, message

def _method():
    """The API method being called, lower-cased and without ".view"."""
    m = request.path.rsplit("/", 1)[-1].lower()
    return m[:-5] if m.endswith(".view") else m

def _sid(prefix, text):
    return prefix + hashlib.md5(text.encode("utf-8")).hexdigest()[:20]

def ss_library():
    """ID maps for the API, rebuilt whenever the library index changes."""
    if _SS["version"] == library_version: return _SS
    with library_cache_lock:
        tree, version = cached_prebuilt_tree, library_version
    artists, albums, songs, by_rel = {}, {}, {}, {}
    for a in tree:
        arid = _sid("ar-", a["artist"].lower())
        ar = artists.setdefault(arid, {"id": arid, "name": a["artist"], "albums": []})
        for alb in a["albums"]:
            alid = _sid("al-", a["artist"].lower() + "\x00" + alb["name"].lower())
            al = albums.get(alid) or {"id": alid, "name": alb["name"], "artist": a["artist"], "artistId": arid,
                                      "songs": [], "cover": None, "created": 0, "duration": 0}
            for t in alb["tracks"]:
                sid = _sid("tr-", t["rel_path"])
                songs[sid] = {"t": t, "albumId": alid, "artistId": arid}
                by_rel[t["rel_path"]] = sid
                al["songs"].append(sid)
                if not al["cover"] and t.get("has_cover"): al["cover"] = sid
                al["created"] = max(al["created"], t.get("mtime") or 0)
                al["duration"] += int(t.get("duration") or 0)
            if not al["cover"] and al["songs"]: al["cover"] = al["songs"][0]
            if alid not in albums:
                albums[alid] = al
                ar["albums"].append(alid)
    _SS.update(version=version, artists=artists, albums=albums, songs=songs, by_rel=by_rel)
    return _SS

def _iso(ts):
    return datetime.utcfromtimestamp(ts).strftime("%Y-%m-%dT%H:%M:%S.000Z") if ts else None

def _p(name, default=None):
    v = request.values.get(name)
    return default if v is None else v

def _pint(name, default, lo=0, hi=10000):
    try: return max(lo, min(hi, int(request.values.get(name, default))))
    except (TypeError, ValueError): return default

def _need(name):
    v = request.values.get(name)
    if v in (None, ""): raise SSError(10, f"Required parameter is missing: {name}")
    return v

def ss_user_ctx(username):
    with users_lock:
        rec = users_data.get(username) or {}
        star = rec.get("subsonic_starred") or {}
        return {"username": username, "liked": set(rec.get("liked_songs", [])),
                "plays": {h.get("rel_path"): h.get("count", 1) for h in rec.get("history", [])},
                "albums": set(star.get("albums", [])), "artists": set(star.get("artists", [])),
                "admin": bool(rec.get("is_admin"))}

def ss_song(sid, lib, ctx):
    e = lib["songs"][sid]; t = e["t"]; al = lib["albums"][e["albumId"]]
    rel = t["rel_path"]; ext = Path(rel).suffix.lower()
    out = {"id": sid, "parent": e["albumId"], "isDir": False, "title": t.get("title") or Path(rel).stem,
           "album": al["name"], "artist": t.get("display_artist") or t.get("artist") or al["artist"],
           "coverArt": sid if t.get("has_cover") else al["cover"], "contentType": AUDIO_TYPES.get(ext, "audio/mpeg"),
           "suffix": ext.lstrip("."), "path": rel, "albumId": e["albumId"], "artistId": e["artistId"],
           "type": "music", "mediaType": "song", "isVideo": False}
    m = re.match(r"\d+", str(t.get("track_number") or ""))
    if m: out["track"] = int(m.group())
    if t.get("duration"): out["duration"] = int(round(t["duration"]))
    if t.get("mtime"): out["created"] = _iso(t["mtime"])
    if rel in ctx["liked"]: out["starred"] = _iso(t.get("mtime") or time.time())
    if ctx["plays"].get(rel): out["playCount"] = ctx["plays"][rel]
    return out

def ss_album(alid, lib, ctx, songs=False):
    al = lib["albums"][alid]
    out = {"id": alid, "parent": al["artistId"], "isDir": True, "name": al["name"], "title": al["name"], "album": al["name"],
           "artist": al["artist"], "artistId": al["artistId"], "coverArt": al["cover"], "songCount": len(al["songs"]),
           "duration": al["duration"], "created": _iso(al["created"]),
           "playCount": sum(ctx["plays"].get(lib["songs"][s]["t"]["rel_path"], 0) for s in al["songs"])}
    if alid in ctx["albums"]: out["starred"] = _iso(al["created"] or time.time())
    if songs: out["song"] = [ss_song(s, lib, ctx) for s in al["songs"]]
    return out

def ss_artist(arid, lib, ctx, albums=False):
    ar = lib["artists"][arid]
    out = {"id": arid, "name": ar["name"], "albumCount": len(ar["albums"]),
           "coverArt": lib["albums"][ar["albums"][0]]["cover"] if ar["albums"] else None}
    if arid in ctx["artists"]: out["starred"] = _iso(time.time())
    if albums: out["album"] = [ss_album(a, lib, ctx) for a in ar["albums"]]
    return out

def _xml_attr(v):
    return "true" if v is True else "false" if v is False else str(v)

def _to_xml(parent, key, val):
    if isinstance(val, list):
        for v in val: _to_xml(parent, key, v)
    elif isinstance(val, dict):
        el = ET.SubElement(parent, key)
        for k, v in val.items():
            if v is None: continue
            if isinstance(v, (dict, list)): _to_xml(el, k, v)
            elif k == "value": el.text = str(v)
            else: el.set(k, _xml_attr(v))
    elif val is not None:
        ET.SubElement(parent, key).text = str(val)

def ss_response(payload=None, status="ok"):
    body = {"status": status, "version": SUBSONIC_API_VERSION, "type": "axdio", "serverVersion": AXDIO_VERSION,
            "openSubsonic": True, **(payload or {})}
    fmt = request.values.get("f", "xml")
    if fmt in ("json", "jsonp"):
        data = json.dumps({"subsonic-response": body}, ensure_ascii=False)
        cb = request.values.get("callback", "")
        if fmt == "jsonp" and re.fullmatch(r"[A-Za-z_$][\w$.]{0,60}", cb):
            return Response(f"{cb}({data});", mimetype="application/javascript")
        return Response(data, mimetype="application/json")
    root = ET.Element("subsonic-response", {"xmlns": "http://subsonic.org/restapi"})
    for k, v in body.items():
        if isinstance(v, (dict, list)): _to_xml(root, k, v)
        elif v is not None: root.set(k, _xml_attr(v))
    return Response(b'<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(root, encoding="utf-8"), mimetype="text/xml")

def ss_error(code, message):
    return ss_response({"error": {"code": code, "message": message}}, "failed")

# --- App passwords ---
def _ss_keystream(salt, n):
    key = str(app.secret_key).encode()
    out, i = b"", 0
    while len(out) < n:
        out += hmac.new(key, salt + i.to_bytes(4, "big"), hashlib.sha256).digest(); i += 1
    return out[:n]

def app_password_create(rec):
    pw = secrets.token_urlsafe(18)
    salt = secrets.token_bytes(16)
    enc = bytes(a ^ b for a, b in zip(pw.encode(), _ss_keystream(salt, len(pw))))
    rec["subsonic"] = {"salt": base64.b64encode(salt).decode(), "enc": base64.b64encode(enc).decode(), "created": time.time()}
    _ss_auth_cache.clear()
    return pw

def app_password_get(rec):
    s = rec.get("subsonic") or {}
    try:
        salt, enc = base64.b64decode(s["salt"]), base64.b64decode(s["enc"])
        return bytes(a ^ b for a, b in zip(enc, _ss_keystream(salt, len(enc)))).decode()
    except Exception: return None

def ss_auth():
    c = cfg()
    if not c.get("feature_subsonic", True): raise SSError(50, "The Subsonic API is turned off on this server.")
    username = (request.values.get("u") or "").strip().lower()
    if not username: raise SSError(10, "Required parameter is missing: u")
    ip = client_ip()
    if login_locked(ip): raise SSError(40, LOCKED_MSG)
    t, salt, p = request.values.get("t"), request.values.get("s"), request.values.get("p")
    if not ((t and salt) or p is not None): raise SSError(10, "Required parameter is missing: p, or t and s")
    ok = False
    with users_lock:
        rec = users_data.get(username)
        if rec and not rec.get("disabled"):
            app_pw = app_password_get(rec)
            if t and salt:
                if not app_pw: raise SSError(41, "Create an app password in the web app's Settings, then sign in with it.")
                ok = hmac.compare_digest(hashlib.md5((app_pw + salt).encode()).hexdigest(), t.lower())
            else:
                if p.startswith("enc:"):
                    try: p = bytes.fromhex(p[4:]).decode()
                    except ValueError: p = ""
                key = (username, hashlib.sha256(p.encode()).hexdigest(), rec.get("password"))
                if app_pw and hmac.compare_digest(p, app_pw): ok = True
                elif _ss_auth_cache.get(key, 0) > time.time(): ok = True
                elif verify_pw(p, rec.get("password", "")):
                    ok = True
                    _ss_auth_cache[key] = time.time() + 600   # pbkdf2 is slow; apps call the API constantly
    if not ok:
        login_failed(ip, username, "app")
        raise SSError(40, "Wrong username or password.")
    if c.get("maintenance_mode") and not (users_data.get(username) or {}).get("is_admin"):
        raise SSError(0, "The server is under maintenance.")
    return username

SS_HANDLERS = {}
def ss(*names, auth=True):
    def deco(fn):
        for n in names: SS_HANDLERS[n.lower()] = (fn, auth)
        return fn
    return deco

@app.route("/rest/<path:method>", methods=["GET", "POST"])
def subsonic_api(method):
    name = _method()
    h = SS_HANDLERS.get(name)
    if not h: return ss_error(0, f"Not supported: {method}")
    fn, need_auth = h
    try:
        user = ss_auth() if need_auth else None
        return fn(user)
    except SSError as ex:
        return ss_error(ex.code, ex.message)
    except Exception as ex:
        print(f"[ERROR] Subsonic {name}: {ex}")
        return ss_error(0, "Something went wrong on the server.")

def _lookup(kind, sid):
    lib = ss_library()
    table = {"song": lib["songs"], "album": lib["albums"], "artist": lib["artists"]}[kind]
    if sid not in table: raise SSError(70, f"{kind.capitalize()} not found.")
    return lib

def _index_letter(name):
    n = name
    for art in SS_IGNORED_ARTICLES.split():
        if n.lower().startswith(art.lower() + " "): n = n[len(art) + 1:]; break
    c = (n[:1] or "#").upper()
    return c if c.isalpha() else "#"

def _artist_index(lib, ctx):
    groups = {}
    for arid, ar in sorted(lib["artists"].items(), key=lambda kv: kv[1]["name"].lower()):
        groups.setdefault(_index_letter(ar["name"]), []).append(ss_artist(arid, lib, ctx))
    return [{"name": k, "artist": groups[k]} for k in sorted(groups)]

# --- System ---
@ss("ping")
def ss_ping(user): return ss_response()

@ss("getLicense")
def ss_license(user): return ss_response({"license": {"valid": True, "email": "", "licenseExpires": "2099-12-31T00:00:00.000Z"}})

@ss("getOpenSubsonicExtensions", auth=False)
def ss_extensions(user):
    return ss_response({"openSubsonicExtensions": [{"name": "formPost", "versions": [1]}, {"name": "songLyrics", "versions": [1]}]})

@ss("getMusicFolders")
def ss_folders(user): return ss_response({"musicFolders": {"musicFolder": [{"id": 1, "name": cfg().get("site_title", "Music")}]}})

@ss("getScanStatus")
def ss_scan_status(user): return ss_response({"scanStatus": {"scanning": SCAN["running"], "count": SCAN["files"] or cached_prebuilt_count}})

@ss("startScan")
def ss_start_scan(user):
    if not ss_user_ctx(user)["admin"]: raise SSError(50, "Only admins can start a scan.")
    _scan_now.set()
    return ss_response({"scanStatus": {"scanning": True, "count": SCAN["files"]}})

@ss("getUser")
def ss_get_user(user):
    who = (_p("username") or user).lower()
    ctx = ss_user_ctx(user)
    if who != user and not ctx["admin"]: raise SSError(50, "You can only look up your own account.")
    if who not in users_data: raise SSError(70, "User not found.")
    is_admin = bool(users_data[who].get("is_admin"))
    return ss_response({"user": {"username": who, "email": "", "scrobblingEnabled": True, "adminRole": is_admin, "settingsRole": True,
                                 "downloadRole": bool(cfg().get("feature_offline", True)), "uploadRole": False, "playlistRole": True,
                                 "coverArtRole": False, "commentRole": False, "podcastRole": False, "streamRole": True, "jukeboxRole": False,
                                 "shareRole": False, "videoConversionRole": False, "folder": [1]}})

# --- Browsing ---
@ss("getIndexes")
def ss_indexes(user):
    lib = ss_library()
    return ss_response({"indexes": {"lastModified": int(library_version), "ignoredArticles": SS_IGNORED_ARTICLES,
                                    "index": _artist_index(lib, ss_user_ctx(user))}})

@ss("getArtists")
def ss_artists(user):
    lib = ss_library()
    return ss_response({"artists": {"ignoredArticles": SS_IGNORED_ARTICLES, "index": _artist_index(lib, ss_user_ctx(user))}})

@ss("getArtist")
def ss_get_artist(user):
    sid = _need("id"); lib = _lookup("artist", sid)
    return ss_response({"artist": ss_artist(sid, lib, ss_user_ctx(user), albums=True)})

@ss("getAlbum")
def ss_get_album(user):
    sid = _need("id"); lib = _lookup("album", sid)
    return ss_response({"album": ss_album(sid, lib, ss_user_ctx(user), songs=True)})

@ss("getSong")
def ss_get_song(user):
    sid = _need("id"); lib = _lookup("song", sid)
    return ss_response({"song": ss_song(sid, lib, ss_user_ctx(user))})

@ss("getMusicDirectory")
def ss_directory(user):
    sid = _need("id"); lib = ss_library(); ctx = ss_user_ctx(user)
    if sid in lib["artists"]:
        ar = lib["artists"][sid]
        return ss_response({"directory": {"id": sid, "name": ar["name"], "child": [ss_album(a, lib, ctx) for a in ar["albums"]]}})
    if sid in lib["albums"]:
        al = lib["albums"][sid]
        return ss_response({"directory": {"id": sid, "parent": al["artistId"], "name": al["name"],
                                          "child": [ss_song(s, lib, ctx) for s in al["songs"]]}})
    raise SSError(70, "Folder not found.")

@ss("getGenres")
def ss_genres(user): return ss_response({"genres": {"genre": []}})

@ss("getArtistInfo", "getArtistInfo2")
def ss_artist_info(user):
    key = "artistInfo2" if _method().endswith("2") else "artistInfo"
    return ss_response({key: {}})

@ss("getAlbumInfo", "getAlbumInfo2")
def ss_album_info(user): return ss_response({"albumInfo": {}})

def _songs_for(sid, lib):
    if sid in lib["songs"]: return [sid], lib["songs"][sid]["artistId"]
    if sid in lib["albums"]: return list(lib["albums"][sid]["songs"]), lib["albums"][sid]["artistId"]
    if sid in lib["artists"]: return [s for a in lib["artists"][sid]["albums"] for s in lib["albums"][a]["songs"]], sid
    raise SSError(70, "Not found.")

@ss("getSimilarSongs", "getSimilarSongs2")
def ss_similar(user):
    lib = ss_library(); ctx = ss_user_ctx(user)
    seed, arid = _songs_for(_need("id"), lib)
    pool = [s for a in lib["artists"][arid]["albums"] for s in lib["albums"][a]["songs"] if s not in seed]
    random.shuffle(pool)
    pool += random.sample(list(lib["songs"]), min(len(lib["songs"]), 50))
    count = _pint("count", 50, 1, 500)
    out, seen = [], set(seed)
    for s in pool:
        if s not in seen: seen.add(s); out.append(ss_song(s, lib, ctx))
        if len(out) >= count: break
    key = "similarSongs2" if _method().endswith("2") else "similarSongs"
    return ss_response({key: {"song": out}})

@ss("getTopSongs")
def ss_top_songs(user):
    lib = ss_library(); ctx = ss_user_ctx(user)
    name = _need("artist").lower()
    arid = next((a for a, ar in lib["artists"].items() if ar["name"].lower() == name), None)
    if not arid: return ss_response({"topSongs": {"song": []}})
    plays = collections.Counter()
    with users_lock:
        for rec in users_data.values():
            for h in rec.get("history", []): plays[h.get("rel_path")] += h.get("count", 1)
    songs = [s for a in lib["artists"][arid]["albums"] for s in lib["albums"][a]["songs"]]
    songs.sort(key=lambda s: -plays.get(lib["songs"][s]["t"]["rel_path"], 0))
    return ss_response({"topSongs": {"song": [ss_song(s, lib, ctx) for s in songs[:_pint("count", 50, 1, 500)]]}})

# --- Lists ---
@ss("getAlbumList", "getAlbumList2")
def ss_album_list(user):
    lib = ss_library(); ctx = ss_user_ctx(user)
    kind = _need("type")
    size, offset = _pint("size", 10, 1, 500), _pint("offset", 0, 0, 10 ** 6)
    ids = list(lib["albums"])
    if kind == "random": random.shuffle(ids)
    elif kind == "newest": ids.sort(key=lambda a: -lib["albums"][a]["created"])
    elif kind in ("frequent", "highest"):
        ids = [a for a in ids if ss_album(a, lib, ctx)["playCount"]]
        ids.sort(key=lambda a: -ss_album(a, lib, ctx)["playCount"])
    elif kind == "recent":
        last = {}
        with users_lock:
            for h in (users_data.get(user) or {}).get("history", []):
                sid = lib["by_rel"].get(h.get("rel_path"))
                if sid: last[lib["songs"][sid]["albumId"]] = max(last.get(lib["songs"][sid]["albumId"], ""), h.get("last_played") or "")
        ids = sorted(last, key=lambda a: last[a], reverse=True)
    elif kind == "alphabeticalByName": ids.sort(key=lambda a: lib["albums"][a]["name"].lower())
    elif kind == "alphabeticalByArtist": ids.sort(key=lambda a: (lib["albums"][a]["artist"].lower(), lib["albums"][a]["name"].lower()))
    elif kind == "starred": ids = [a for a in ids if a in ctx["albums"]]
    elif kind in ("byYear", "byGenre"): ids = []   # the library doesn't record years or genres yet
    else: raise SSError(0, f"Unknown list type: {kind}")
    key = "albumList2" if _method().endswith("2") else "albumList"
    return ss_response({key: {"album": [ss_album(a, lib, ctx) for a in ids[offset:offset + size]]}})

@ss("getRandomSongs")
def ss_random_songs(user):
    lib = ss_library(); ctx = ss_user_ctx(user)
    ids = random.sample(list(lib["songs"]), min(len(lib["songs"]), _pint("size", 10, 1, 500)))
    return ss_response({"randomSongs": {"song": [ss_song(s, lib, ctx) for s in ids]}})

@ss("getSongsByGenre")
def ss_songs_by_genre(user): return ss_response({"songsByGenre": {"song": []}})

@ss("getNowPlaying")
def ss_now_playing(user): return ss_response({"nowPlaying": {"entry": []}})

@ss("getStarred", "getStarred2")
def ss_starred(user):
    lib = ss_library(); ctx = ss_user_ctx(user)
    body = {"artist": [ss_artist(a, lib, ctx) for a in ctx["artists"] if a in lib["artists"]],
            "album": [ss_album(a, lib, ctx) for a in ctx["albums"] if a in lib["albums"]],
            "song": [ss_song(lib["by_rel"][r], lib, ctx) for r in ctx["liked"] if r in lib["by_rel"]]}
    key = "starred2" if _method().endswith("2") else "starred"
    return ss_response({key: body})

# --- Searching ---
@ss("search2", "search3")
def ss_search(user):
    lib = ss_library(); ctx = ss_user_ctx(user)
    q = (_p("query", "") or "").strip().strip('"').lower()
    def page(items, cname, oname, default):
        n, off = _pint(cname, default, 0, 10000), _pint(oname, 0, 0, 10 ** 6)
        return items[off:off + n]
    artists = [a for a, ar in lib["artists"].items() if not q or q in ar["name"].lower()]
    albums = [a for a, al in lib["albums"].items() if not q or q in al["name"].lower() or q in al["artist"].lower()]
    songs = [s for s, e in lib["songs"].items() if not q or q in (e["t"].get("title") or "").lower() or q in (e["t"].get("display_artist") or e["t"].get("artist") or "").lower()]
    body = {"artist": [ss_artist(a, lib, ctx) for a in page(artists, "artistCount", "artistOffset", 20)],
            "album": [ss_album(a, lib, ctx) for a in page(albums, "albumCount", "albumOffset", 20)],
            "song": [ss_song(s, lib, ctx) for s in page(songs, "songCount", "songOffset", 20)]}
    key = "searchResult3" if _method() == "search3" else "searchResult2"
    return ss_response({key: body})

# --- Playlists (the account's own playlists from the web app) ---
def _pl_id(user, name): return _sid("pl-", user + "\x00" + name)

def _pl_find(user, pid):
    with users_lock:
        for name in (users_data.get(user) or {}).get("playlists", {}):
            if _pl_id(user, name) == pid: return name
    raise SSError(70, "Playlist not found.")

def ss_playlist(user, name, lib, ctx, entries=False):
    with users_lock: rels = list((users_data.get(user) or {}).get("playlists", {}).get(name, []))
    sids = [lib["by_rel"][r] for r in rels if r in lib["by_rel"]]
    out = {"id": _pl_id(user, name), "name": name, "owner": user, "public": False, "songCount": len(sids),
           "duration": sum(int(lib["songs"][s]["t"].get("duration") or 0) for s in sids),
           "created": _iso(SERVER_START_TIME), "changed": _iso(time.time()), "coverArt": sids[0] if sids else None}
    if entries: out["entry"] = [ss_song(s, lib, ctx) for s in sids]
    return out

@ss("getPlaylists")
def ss_playlists(user):
    lib = ss_library(); ctx = ss_user_ctx(user)
    with users_lock: names = list((users_data.get(user) or {}).get("playlists", {}))
    return ss_response({"playlists": {"playlist": [ss_playlist(user, n, lib, ctx) for n in names]}})

@ss("getPlaylist")
def ss_get_playlist(user):
    lib = ss_library(); name = _pl_find(user, _need("id"))
    return ss_response({"playlist": ss_playlist(user, name, lib, ss_user_ctx(user), entries=True)})

def _rels_for(sids, lib):
    return [lib["songs"][s]["t"]["rel_path"] for s in sids if s in lib["songs"]]

@ss("createPlaylist")
def ss_create_playlist(user):
    lib = ss_library()
    songs = _rels_for(request.values.getlist("songId"), lib)
    with users_lock:
        pls = users_data[user].setdefault("playlists", {})
        pid = _p("playlistId")
        name = _pl_find(user, pid) if pid else (_p("name") or "").strip()[:100]
        if not name: raise SSError(10, "Required parameter is missing: name")
        pls[name] = songs
        save_users(user)
    return ss_response({"playlist": ss_playlist(user, name, lib, ss_user_ctx(user), entries=True)})

@ss("updatePlaylist")
def ss_update_playlist(user):
    lib = ss_library()
    name = _pl_find(user, _need("playlistId"))
    with users_lock:
        pls = users_data[user]["playlists"]
        rels = list(pls.get(name, []))
        drop = {int(i) for i in request.values.getlist("songIndexToRemove") if str(i).isdigit()}
        rels = [r for i, r in enumerate(rels) if i not in drop] + _rels_for(request.values.getlist("songIdToAdd"), lib)
        new_name = (_p("name") or "").strip()[:100]
        if new_name and new_name != name and new_name not in pls:
            del pls[name]; name = new_name
        pls[name] = rels
        save_users(user)
    return ss_response()

@ss("deletePlaylist")
def ss_delete_playlist(user):
    name = _pl_find(user, _need("id"))
    with users_lock:
        users_data[user]["playlists"].pop(name, None)
        save_users(user)
    return ss_response()

# --- Media ---
def _song_file(sid):
    lib = _lookup("song", sid)
    rel = lib["songs"][sid]["t"]["rel_path"]
    if FED_REMOTE_RE.match(rel): return rel, None   # shared by another server
    fp = resolve_safe_music_file(rel)
    if not fp: raise SSError(70, "The file for this song is missing.")
    return rel, fp

@ss("stream")
def ss_stream(user):
    rel, fp = _song_file(_need("id"))
    fmt = (_p("format") or "").lower()
    max_kbps = _pint("maxBitRate", 0, 0, 10000)
    kbps = None
    if fmt != "raw" and (max_kbps or fmt == "mp3"):
        want = max_kbps or 320
        kbps = 320 if want >= 320 else 192 if want >= 192 else 128
    with listeners_lock:
        listeners[client_ip()] = {"ip": client_ip(), "ua": (request.headers.get("User-Agent") or "App")[:40], "last_seen": time.time(),
                                  "path": Path(rel).name, "status": "STREAMING", "is_playing": True}
    return remote_stream(rel, kbps) if fp is None else stream_file_response(fp, rel, kbps)

@ss("download")
def ss_download(user):
    if not cfg().get("feature_offline", True): raise SSError(50, "Downloads are turned off on this server.")
    rel, fp = _song_file(_need("id"))
    if fp is None: return remote_stream(rel)
    return send_file(str(fp), mimetype=AUDIO_TYPES.get(fp.suffix.lower(), "application/octet-stream"), as_attachment=True,
                     download_name=fp.name, conditional=True)

@ss("getCoverArt")
def ss_cover(user):
    sid = _need("id"); lib = ss_library()
    if sid in lib["albums"]: sid = lib["albums"][sid]["cover"]
    elif sid in lib["artists"]:
        ar = lib["artists"][sid]
        sid = lib["albums"][ar["albums"][0]]["cover"] if ar["albums"] else None
    elif sid.startswith("pl-"):
        return Response(DEFAULT_SVG_COVER, mimetype="image/svg+xml")
    if not sid or sid not in lib["songs"]: raise SSError(70, "Cover art not found.")
    return cover_response(lib["songs"][sid]["t"]["rel_path"])

@ss("getAvatar")
def ss_avatar(user):
    with users_lock: f = avatar_file((users_data.get(_p("username") or user) or {}).get("avatar"))
    if f and f.exists(): return send_file(f, mimetype="image/jpeg", max_age=86400)
    return Response(DEFAULT_SVG_COVER, mimetype="image/svg+xml")

@ss("getLyrics")
def ss_lyrics(user):
    artist, title = _p("artist", ""), _p("title", "")
    if not cfg().get("feature_lyrics", True) or not artist or not title: return ss_response({"lyrics": {}})
    d = lyrics_for(artist, title)
    text = d.get("plain") or re.sub(r"\[\d+:\d+(?:[.:]\d+)?\]", "", d.get("synced") or "").strip()
    return ss_response({"lyrics": {"artist": artist, "title": title, "value": text}} if text else {"lyrics": {}})

@ss("getLyricsBySongId")
def ss_lyrics_by_id(user):
    sid = _need("id"); lib = _lookup("song", sid)
    t = lib["songs"][sid]["t"]
    if not cfg().get("feature_lyrics", True): return ss_response({"lyricsList": {"structuredLyrics": []}})
    artist = t.get("display_artist") or t.get("artist") or ""
    d = lyrics_for(artist, t.get("title") or "", t.get("album") or "")
    out = []
    if d.get("synced"):
        lines = []
        for line in str(d["synced"]).splitlines():
            text = re.sub(r"\[\d+:\d+(?:[.:]\d+)?\]", "", line).strip()
            for m in re.finditer(r"\[(\d+):(\d+)(?:[.:](\d+))?\]", line):
                ms = int(m.group(1)) * 60000 + int(m.group(2)) * 1000 + (int((m.group(3) or "0").ljust(3, "0")[:3]))
                lines.append({"start": ms, "value": text})
        lines.sort(key=lambda x: x["start"])
        out.append({"displayArtist": artist, "displayTitle": t.get("title"), "lang": "und", "synced": True, "line": lines})
    elif d.get("plain"):
        out.append({"displayArtist": artist, "displayTitle": t.get("title"), "lang": "und", "synced": False,
                    "line": [{"value": l} for l in str(d["plain"]).splitlines()]})
    return ss_response({"lyricsList": {"structuredLyrics": out}})

# --- Stars, ratings, scrobbles ---
def _star(user, on):
    lib = ss_library()
    with users_lock:
        rec = users_data[user]
        liked = rec.setdefault("liked_songs", [])
        star = rec.setdefault("subsonic_starred", {"albums": [], "artists": []})
        for sid in request.values.getlist("id"):
            if sid in lib["songs"]:
                rel = lib["songs"][sid]["t"]["rel_path"]
                if on and rel not in liked: liked.append(rel)
                if not on and rel in liked: liked.remove(rel)
            elif sid in lib["albums"]: _toggle(star["albums"], sid, on)
            elif sid in lib["artists"]: _toggle(star["artists"], sid, on)
        for sid in request.values.getlist("albumId"): _toggle(star["albums"], sid, on)
        for sid in request.values.getlist("artistId"): _toggle(star["artists"], sid, on)
        save_users(user)
    return ss_response()

def _toggle(lst, item, on):
    if on and item not in lst: lst.append(item)
    if not on and item in lst: lst.remove(item)

@ss("star")
def ss_star(user): return _star(user, True)

@ss("unstar")
def ss_unstar(user): return _star(user, False)

@ss("setRating")
def ss_rating(user): return ss_response()

@ss("scrobble")
def ss_scrobble(user):
    lib = ss_library()
    submission = (_p("submission", "true") or "true").lower() != "false"
    for sid in request.values.getlist("id"):
        if sid not in lib["songs"]: continue
        rel = lib["songs"][sid]["t"]["rel_path"]
        if submission:
            record_play_for(user, rel)
            scrobble_play(user, rel)
        else:
            with listeners_lock:
                listeners[client_ip()] = {"ip": client_ip(), "ua": (request.headers.get("User-Agent") or "App")[:40], "last_seen": time.time(),
                                          "path": Path(rel).name, "status": "STREAMING", "is_playing": True}
    return ss_response()

# --- Things this server doesn't have: answer with empty lists so apps don't show errors ---
@ss("getPlayQueue")
def ss_play_queue(user): return ss_response({"playQueue": {}})

@ss("savePlayQueue", "createBookmark", "deleteBookmark")
def ss_noop(user): return ss_response()

@ss("getBookmarks")
def ss_bookmarks(user): return ss_response({"bookmarks": {"bookmark": []}})

@ss("getInternetRadioStations")
def ss_radio(user): return ss_response({"internetRadioStations": {"internetRadioStation": []}})

@ss("getPodcasts")
def ss_podcasts(user): return ss_response({"podcasts": {"channel": []}})

@ss("getNewestPodcasts")
def ss_newest_podcasts(user): return ss_response({"newestPodcasts": {"episode": []}})

@ss("getShares")
def ss_shares(user): return ss_response({"shares": {"share": []}})

@ss("getChatMessages")
def ss_chat(user): return ss_response({"chatMessages": {"chatMessage": []}})

@ss("getUsers")
def ss_users(user):
    if not ss_user_ctx(user)["admin"]: raise SSError(50, "Only admins can list users.")
    with users_lock: names = list(users_data)
    return ss_response({"users": {"user": [{"username": n, "adminRole": bool(users_data[n].get("is_admin")), "streamRole": True} for n in names]}})

# --- Web app: manage the app password ---
@app.route("/api/user/subsonic", methods=["GET", "POST"])
def user_subsonic():
    u = _me()
    with users_lock:
        rec = users_data[u]
        pw = None
        if request.method == "POST":
            action = (request.get_json(silent=True) or {}).get("action")
            if action == "create": pw = app_password_create(rec)
            elif action == "revoke": rec.pop("subsonic", None); _ss_auth_cache.clear()
            else: return jsonify({"error": "Unknown action."}), 400
            save_users(u)
            activity("account", "Created an app password" if pw else "Revoked the app password", u)
        info = rec.get("subsonic") or {}
    return jsonify({"enabled": bool(cfg().get("feature_subsonic", True)), "server": base_url(), "username": u,
                    "has_password": bool(info), "created": info.get("created"), "password": pw})

# ============================================================
# SCROBBLING (ListenBrainz, Last.fm)
# ============================================================
# Listeners connect their own accounts in Settings: ListenBrainz with their user token, Last.fm
# through Last.fm's sign-in page (needs the admin's API key and secret). The web app sends a
# scrobble after half the song or 4 minutes; Subsonic apps send theirs with scrobble?submission=true.
LB_API = "https://api.listenbrainz.org/1"
LASTFM_API = "https://ws.audioscrobbler.com/2.0/"

def _track_meta(rel_path):
    e = dict(library_entry(rel_path) or {})
    return {"artist": to_clean_str(e.get("artist"), ""), "title": to_clean_str(e.get("title"), Path(rel_path).stem),
            "album": to_clean_str(e.get("album"), ""), "duration": e.get("duration")}

def _http_json(url, data=None, headers=None, timeout=10):
    body = None
    if isinstance(data, dict) and (headers or {}).get("Content-Type") == "application/json": body = json.dumps(data).encode()
    elif isinstance(data, dict): body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(url, data=body, headers={"User-Agent": f"Axdio/{AXDIO_VERSION}", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r: return json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as ex:
        try: return json.loads(ex.read().decode() or "{}") | {"_status": ex.code}
        except Exception: return {"_status": ex.code}

def _lb_listen(token, kind, meta, listened_at=None):
    tm = {"artist_name": meta["artist"], "track_name": meta["title"],
          "additional_info": {"media_player": "Axdio", "submission_client": "Axdio", "submission_client_version": AXDIO_VERSION}}
    if meta["album"] and meta["album"].lower() not in ("singles", "single"): tm["release_name"] = meta["album"]
    if meta["duration"]: tm["additional_info"]["duration_ms"] = int(meta["duration"] * 1000)
    item = {"track_metadata": tm}
    if kind == "single": item["listened_at"] = int(listened_at or time.time())
    return _http_json(f"{LB_API}/submit-listens", {"listen_type": kind, "payload": [item]},
                      {"Content-Type": "application/json", "Authorization": f"Token {token}"})

def _lastfm(method, params, signed=True):
    c = cfg()
    p = {**{k: str(v) for k, v in params.items() if v not in (None, "")}, "method": method, "api_key": c.get("lastfm_api_key", "")}
    if signed:
        p["api_sig"] = hashlib.md5(("".join(k + p[k] for k in sorted(p)) + c.get("lastfm_api_secret", "")).encode("utf-8")).hexdigest()
    p["format"] = "json"
    return _http_json(LASTFM_API, p)

def lastfm_available():
    c = cfg()
    return bool(c.get("feature_scrobbling", True) and c.get("lastfm_api_key") and c.get("lastfm_api_secret"))

def _scrobble(username, rel_path, now_playing, listened_at=None):
    if not cfg().get("feature_scrobbling", True): return
    with users_lock: sc = dict((users_data.get(username) or {}).get("scrobbling") or {})
    if not (sc.get("listenbrainz_token") or sc.get("lastfm_session")): return
    meta = _track_meta(rel_path)
    if not meta["artist"] or meta["artist"] == "Unknown Artist": return
    def run():
        errors = {}
        if sc.get("listenbrainz_token"):
            r = _lb_listen(sc["listenbrainz_token"], "playing_now" if now_playing else "single", meta, listened_at)
            if r.get("status") != "ok": errors["listenbrainz"] = r.get("error") or f"HTTP {r.get('_status')}"
        if sc.get("lastfm_session") and lastfm_available():
            params = {"artist": meta["artist"], "track": meta["title"], "album": meta["album"] if meta["album"].lower() not in ("singles", "single") else "",
                      "duration": int(meta["duration"]) if meta["duration"] else "", "sk": sc["lastfm_session"]}
            if not now_playing: params["timestamp"] = int(listened_at or time.time())
            r = _lastfm("track.updateNowPlaying" if now_playing else "track.scrobble", params)
            if r.get("error"): errors["lastfm"] = r.get("message") or f"error {r['error']}"
        if not now_playing:
            with users_lock:
                rec = users_data.get(username)
                if rec is not None:
                    st = rec.setdefault("scrobbling", {})
                    st["last_error"] = "; ".join(f"{k}: {v}" for k, v in errors.items())
                    if not errors: st["last_ok"] = time.time()
                    save_users(username)
    threading.Thread(target=run, daemon=True, name="scrobble").start()

def scrobble_play(username, rel_path, listened_at=None):
    _scrobble(username, rel_path, False, listened_at)

def scrobble_now_playing(username, rel_path):
    _scrobble(username, rel_path, True)

@app.route("/api/user/scrobble", methods=["POST"])
def user_scrobble():
    u = _me()
    d = request.get_json(silent=True) or {}
    rel = d.get("rel_path") or ""
    if library_entry(rel) is None: return jsonify({"error": "Unknown song."}), 400
    started = d.get("started_at")
    scrobble_play(u, rel, int(started) if isinstance(started, (int, float)) and started > 1e9 else None)
    return jsonify({"ok": True})

def _scrobbling_state(u):
    with users_lock: sc = dict((users_data.get(u) or {}).get("scrobbling") or {})
    return {"enabled": bool(cfg().get("feature_scrobbling", True)),
            "listenbrainz": {"connected": bool(sc.get("listenbrainz_token")), "user": sc.get("listenbrainz_user", "")},
            "lastfm": {"available": lastfm_available(), "connected": bool(sc.get("lastfm_session")), "user": sc.get("lastfm_user", "")},
            "last_ok": sc.get("last_ok"), "last_error": sc.get("last_error", "")}

@app.route("/api/user/scrobbling", methods=["GET", "POST"])
def user_scrobbling():
    u = _me()
    if request.method == "POST":
        d = request.get_json(silent=True) or {}
        service = d.get("service")
        with users_lock:
            sc = users_data[u].setdefault("scrobbling", {})
            if d.get("disconnect"):
                if service == "listenbrainz": sc.pop("listenbrainz_token", None); sc.pop("listenbrainz_user", None)
                elif service == "lastfm": sc.pop("lastfm_session", None); sc.pop("lastfm_user", None)
                save_users(u)
                return jsonify(_scrobbling_state(u))
        if service == "listenbrainz":
            token = (d.get("token") or "").strip()
            if not re.fullmatch(r"[A-Za-z0-9-]{20,64}", token): return jsonify({"error": "That doesn't look like a ListenBrainz user token."}), 400
            r = _http_json(f"{LB_API}/validate-token", headers={"Authorization": f"Token {token}"})
            if not r.get("valid"): return jsonify({"error": "ListenBrainz didn't accept that token."}), 400
            with users_lock:
                sc = users_data[u].setdefault("scrobbling", {})
                sc.update(listenbrainz_token=token, listenbrainz_user=r.get("user_name", ""))
                save_users(u)
            activity("account", "Connected ListenBrainz", u)
            return jsonify(_scrobbling_state(u))
        return jsonify({"error": "Unknown service."}), 400
    return jsonify(_scrobbling_state(u))

@app.route("/api/user/scrobbling/lastfm/connect")
def lastfm_connect():
    if not get_current_user(): return redirect("/settings")
    if not lastfm_available(): return redirect("/settings?lastfm=unavailable")
    cb = base_url() + "/api/user/scrobbling/lastfm/callback"
    return redirect("https://www.last.fm/api/auth/?" + urllib.parse.urlencode({"api_key": cfg()["lastfm_api_key"], "cb": cb}))

@app.route("/api/user/scrobbling/lastfm/callback")
def lastfm_callback():
    u = get_current_user()
    token = request.args.get("token", "")
    if not u or not token or not lastfm_available(): return redirect("/settings?lastfm=failed")
    r = _lastfm("auth.getSession", {"token": token})
    sess = (r.get("session") or {})
    if not sess.get("key"): return redirect("/settings?lastfm=failed")
    with users_lock:
        sc = users_data[u].setdefault("scrobbling", {})
        sc.update(lastfm_session=sess["key"], lastfm_user=sess.get("name", ""))
        save_users(u)
    activity("account", "Connected Last.fm", u)
    return redirect("/settings?lastfm=connected")

# --- Share links ---
# /track/<id>, /album/<id> and /artist/<id> are small pages with link-preview tags (title, artist, a 1200x630
# artwork image and an accent colour for the embed) and a player. An id is the 64-bit FNV-1a hash of
# "t\0<file path>", "a\0<album key>" or "r\0<artist key>" written in base62; web/app/core.js computes the same ids,
# so copying a link needs no request. Album and artist keys are the web apps' lower-case names:
# "<artist>\x01<album>", or "*\x01<album>" for a compilation.
_SHARE_PAGE = re.compile(r"/(track|album|artist)/[0-9A-Za-z]{11}")
_SHARE_OPEN = re.compile(r"/(track|album|artist)/[0-9A-Za-z]{11}/open")
_B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
_SHARE = {"version": None}
_share_lock = threading.Lock()
_ALBUM_SUFFIX = re.compile(r"\s+-\s+(single|ep)$", re.I)

def share_id(kind, ref):
    h = 0xCBF29CE484222325
    for b in f"{kind}\0{ref}".encode("utf-8"):
        h = ((h ^ b) * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    out = ""
    for _ in range(11):
        h, r = divmod(h, 62)
        out = _B62[r] + out
    return out

def share_index():
    """Share id -> song, album or artist; rebuilt when the library changes."""
    with _share_lock:
        if _SHARE["version"] == library_version: return _SHARE
        with library_cache_lock: tree, version = cached_prebuilt_tree, library_version
        tracks, albums, artists = {}, {}, {}
        for a in tree:
            name = str(a.get("artist") or "").strip() or "Unknown Artist"
            akey = name.lower()
            ar = artists.setdefault(akey, {"key": akey, "votes": Counter(), "tracks": [], "albums": []})
            for alb in a.get("albums") or []:
                tr = [t for t in alb.get("tracks") or [] if isinstance(t, dict) and t.get("rel_path") and not t["rel_path"].startswith("@")]
                if not tr: continue
                ar["votes"][name] += len(tr)
                title = str(alb.get("name") or "").strip() or "Unknown Album"
                own = akey + "\x01" + title.lower()
                for key, comp in ((own, False), ("*\x01" + title.lower(), True)):
                    al = albums.setdefault(key, {"key": key, "name": title, "comp": comp, "tracks": [], "artist": akey})
                    al["tracks"].extend(tr)
                ar["tracks"].extend(tr)
                if own not in ar["albums"]: ar["albums"].append(own)
                for t in tr: tracks.setdefault(t["rel_path"], {"t": t, "album": own, "artist": akey})
        _SHARE.update(version=version, albums=albums, artists=artists,
                      track=({share_id("t", rel): v for rel, v in tracks.items()}),
                      album=({share_id("a", k): v for k, v in albums.items()}),
                      artist=({share_id("r", k): v for k, v in artists.items()}))
        return _SHARE

def _share_norm(v):
    return re.sub(r"[^\w]+", " ", str(v or "").lower()).strip()

def _track_no(t):
    m = re.match(r"\d+", str(t.get("track_number") or ""))
    return int(m.group()) if m else 0

def _album_tracks(al):
    """An album's songs in order, each once (the same song filed twice under one release is shown once)."""
    seen, out = set(), []
    for t in al["tracks"]:
        k = (_share_norm(t.get("title")), _share_norm(t.get("display_artist") or t.get("artist")))
        if k in seen: continue
        seen.add(k); out.append(t)
    return sorted(out, key=lambda t: _track_no(t) or 10000)

def _album_kind(al, n):
    if al["comp"]: return "Compilation"
    m = _ALBUM_SUFFIX.search(al["name"])
    if m: return "EP" if m.group(1).lower() == "ep" else "Single"
    return "Single" if n <= 3 else "EP" if n <= 6 else "Album"

def _artist_name(idx, akey):
    ar = idx["artists"].get(akey)
    return ar["votes"].most_common(1)[0][0] if ar and ar["votes"] else akey

def _mmss(sec):
    sec = int(round(sec or 0))
    return f"{sec // 60}:{sec % 60:02d}" if sec else ""

def _long_duration(sec):
    m = int(round((sec or 0) / 60))
    return f"{m // 60} hr {m % 60} min" if m >= 60 else f"{m} min" if m else ""

def _count(n, word):
    return f"{n:,} {word}{'' if n == 1 else 's'}"

_plays_cache = {"t": 0, "plays": Counter()}
def global_plays():
    """Plays per song across every account, refreshed every 10 minutes."""
    if time.time() - _plays_cache["t"] > 600:
        c = Counter()
        with users_lock:
            for rec in users_data.values():
                for h in rec.get("history", []):
                    if h.get("rel_path"): c[h["rel_path"]] += h.get("count", 1)
        _plays_cache.update(t=time.time(), plays=c)
    return _plays_cache["plays"]

def _cover_rel(tracks):
    for t in tracks:
        if t.get("has_cover"): return t["rel_path"]
    return tracks[0]["rel_path"] if tracks else ""

def share_item(kind, sid):
    """What a shared link points to, as the share page and previews need it; None if it's not in the library."""
    idx = share_index()
    e = idx.get(kind, {}).get(sid)
    if not e: return None
    link = lambda k, ref: f"/{k}/{share_id(SHARE_REFS[k], ref)}"
    if kind == "track":
        t, al = e["t"], idx["albums"].get(e["album"])
        n = len(_album_tracks(al)) if al else 1
        album = _ALBUM_SUFFIX.sub("", al["name"]) if al else ""
        artist = t.get("display_artist") or _artist_name(idx, e["artist"])
        return {"kind": kind, "title": t.get("title") or Path(t["rel_path"]).stem, "artist": artist,
                "artist_url": link("artist", e["artist"]), "album": album, "album_url": link("album", e["album"]) if al else "",
                "label": "Song", "cover_rel": t["rel_path"] if t.get("has_cover") else _cover_rel(al["tracks"] if al else [t]),
                "tracks": [t], "duration": t.get("duration") or 0, "single": n <= 1 or album.lower() == str(t.get("title") or "").lower(),
                "app": "/?" + urllib.parse.urlencode({"play": t["rel_path"]})}
    if kind == "album":
        tracks = _album_tracks(e)
        if not tracks: return None
        comp = e["comp"]
        return {"kind": kind, "title": _ALBUM_SUFFIX.sub("", e["name"]), "label": _album_kind(e, len(tracks)),
                "artist": "Various Artists" if comp else _artist_name(idx, e["artist"]),
                "artist_url": "" if comp else link("artist", e["artist"]), "cover_rel": _cover_rel(tracks), "tracks": tracks,
                "duration": sum(t.get("duration") or 0 for t in tracks),
                "app": "/?" + urllib.parse.urlencode({"album": e["key"]})}
    albums = []
    for key in e["albums"]:
        al = idx["albums"].get(key)
        if not al: continue
        at = _album_tracks(al)
        albums.append({"title": _ALBUM_SUFFIX.sub("", al["name"]), "url": link("album", key), "label": _album_kind(al, len(at)),
                       "n": len(at), "tracks": at, "cover_rel": _cover_rel(at), "has_cover": any(t.get("has_cover") for t in at),
                       "mtime": max((t.get("mtime") or 0) for t in at)})
    albums.sort(key=lambda a: -a["mtime"])
    best = max(albums, key=lambda a: (a["has_cover"], a["n"]), default=None)
    # Popular: the most played songs, topped up with the first song of each release, newest first.
    plays = global_plays()
    tracks = sorted((t for t in e["tracks"] if plays.get(t["rel_path"])), key=lambda t: -plays[t["rel_path"]])[:10]
    seen = {t["rel_path"] for t in tracks}
    for a in albums:
        if len(tracks) >= 10: break
        first = next((t for t in a["tracks"] if t["rel_path"] not in seen), None)
        if first: tracks.append(first); seen.add(first["rel_path"])
    for t in e["tracks"]:
        if len(tracks) >= 10: break
        if t["rel_path"] not in seen: tracks.append(t); seen.add(t["rel_path"])
    return {"kind": kind, "title": _artist_name(idx, e["key"]), "label": "Artist", "artist": "", "artist_url": "",
            "cover_rel": best["cover_rel"] if best else _cover_rel(e["tracks"]), "tracks": tracks, "albums": albums,
            "songs": len(e["tracks"]), "app": "/?" + urllib.parse.urlencode({"artist": e["key"]})}

SHARE_REFS = {"track": "t", "album": "a", "artist": "r"}

# Preview images: the artwork, with rounded corners (a circle for artists) and a soft shadow, on a blurred copy of itself.
CARD_W, CARD_H, CARD_ART = 1200, 630, 440
_card_sem = threading.Semaphore(2)
_card_renders = [0]

def _card_mask(shape, r=18):
    if shape == "circle": return "if(lte(hypot(X-W/2,Y-H/2),W/2),255,0)"
    return (f"if(gt(abs(W/2-X),W/2-{r})*gt(abs(H/2-Y),H/2-{r}),"
            f"if(lte(hypot({r}-(W/2-abs(W/2-X)),{r}-(H/2-abs(H/2-Y))),{r}),255,0),255)")

def share_card(cover, shape):
    """A 1200x630 JPEG preview for a cover image, rendered once and kept in config/cards. None if ffmpeg fails."""
    try: st = cover.stat()
    except OSError: return None
    out = CARDS_DIR / (hashlib.md5(f"{cover.name}:{st.st_mtime_ns}:{shape}:1".encode()).hexdigest() + ".jpg")
    if out.exists(): return out
    with _card_sem:
        if out.exists(): return out
        CARDS_DIR.mkdir(parents=True, exist_ok=True)
        tmp = out.with_name(out.stem + ".part.jpg")
        graph = (f"[0:v]scale={CARD_W}:{CARD_W}:force_original_aspect_ratio=increase,crop={CARD_W}:{CARD_H},"
                 f"gblur=sigma=45,eq=brightness=-0.1:saturation=1.35[bg];"
                 f"[0:v]scale={CARD_ART}:{CARD_ART}:flags=lanczos,format=rgba,"
                 f"geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='{_card_mask(shape)}',split[f1][f2];"
                 f"[f2]colorchannelmixer=rr=0:gg=0:bb=0:aa=0.55,pad={CARD_W}:{CARD_H}:(ow-iw)/2:(oh-ih)/2+14:color=black@0,"
                 f"gblur=sigma=22[sh];[bg][sh]overlay=format=auto[b2];[b2][f1]overlay=(W-w)/2:(H-h)/2:format=auto,format=yuvj420p")
        try:
            subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(cover), "-filter_complex", graph,
                            "-frames:v", "1", "-q:v", "3", str(tmp)], check=True, capture_output=True, timeout=60)
            os.replace(tmp, out)
        except Exception as ex:
            tmp.unlink(missing_ok=True)
            print(f"[WARN] Couldn't render a link preview image: {ex}")
            return None
        _card_renders[0] += 1
        if _card_renders[0] % 50 == 0: _prune_cards()
        return out

def _prune_cards(keep=3000):
    """Keep the newest preview images (about 40 KB each); older ones are rendered again if they're needed."""
    try:
        files = sorted(CARDS_DIR.glob("*.jpg"), key=lambda f: f.stat().st_mtime)
        for f in files[:-keep]: f.unlink(missing_ok=True)
    except OSError: pass

_color_cache = {}
def cover_color(cover):
    """A mid-tone colour from the artwork (for the embed's side bar and the page background), or None."""
    try: key = (cover.name, cover.stat().st_mtime_ns)
    except OSError: return None
    if key in _color_cache: return _color_cache[key]
    color = None
    try:
        raw = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(cover), "-vf", "scale=20:20", "-frames:v", "1",
                              "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True, timeout=15, check=True).stdout
        # Weight saturated, mid-bright pixels so large black or white areas don't wash out the hue (as the web apps do).
        r = g = b = w = 0.0
        for i in range(0, len(raw) - 2, 3):
            R, G, B = raw[i], raw[i + 1], raw[i + 2]
            mx, mn = max(R, G, B), min(R, G, B)
            light = (mx + mn) / 510
            sat = 0 if mx == mn else (mx - mn) / ((255 - abs(mx + mn - 255)) or 1)
            wt = .04 + sat * sat * max(0, 1 - abs(light - .5) * 1.7)
            r += R * wt; g += G * wt; b += B * wt; w += wt
        if w:
            import colorsys
            h, _, s = colorsys.rgb_to_hls(r / w / 255, g / w / 255, b / w / 255)
            rgb = colorsys.hls_to_rgb(h, .45, s if s < .08 else min(max(s, .35), .75))
            color = "#" + "".join(f"{round(v * 255):02x}" for v in rgb)
    except Exception: pass
    if len(_color_cache) > 5000: _color_cache.clear()
    _color_cache[key] = color
    return color

def _share_visible():
    """Whether this visitor may see what shared links point to."""
    c = cfg()
    return not c.get("require_login") or c.get("share_previews", True) or bool(get_current_user())

def _share_lookup(kind, sid):
    if not cfg().get("feature_sharing", True) or not _SHARE_PAGE.fullmatch(f"/{kind}/{sid}"): return None
    return share_item(kind, sid)

def _share_missing():
    c = cfg()
    resp = Response(render_template("share.html", missing=True, site=_share_site(c), version=AXDIO_VERSION), 404)
    resp.headers["Cache-Control"] = "no-store"
    return resp

def _share_site(c):
    accent = c.get("accent_color") if re.fullmatch(r"#[0-9a-fA-F]{6}", str(c.get("accent_color") or "")) else "#22c55e"
    n = int(accent[1:], 16)
    lum = (.299 * (n >> 16) + .587 * ((n >> 8) & 255) + .114 * (n & 255)) / 255
    logo = c.get("custom_logo_url") or ""
    return {"title": str(c.get("site_title") or "Axdio"), "accent": accent, "on_accent": "#000" if lum > .55 else "#fff",
            "logo": logo if re.match(r"(https?:)?/", logo) else ""}

@app.route("/<any(track, album, artist):kind>/<sid>")
def share_page(kind, sid):
    item = _share_lookup(kind, sid)
    if not item: return _share_missing()
    if not _share_visible(): return redirect(f"/?next=/{kind}/{sid}/open")
    c = cfg()
    site = _share_site(c)
    base = base_url()
    url = f"{base}/{kind}/{sid}"
    can_play = not c.get("require_login") or bool(get_current_user())
    cover = cover_file_for(item["cover_rel"])
    color = (cover_color(cover) if cover else None) or site["accent"]
    ver = hashlib.md5(f"{cover.name}:{cover.stat().st_mtime_ns}".encode()).hexdigest()[:10] if cover else ""
    n = int(color[1:], 16)
    title, artist = item["title"], item["artist"]
    if kind == "track":
        desc = " · ".join(x for x in (artist, "" if item["single"] else item["album"], _mmss(item["duration"])) if x)
        page_title = f"{title} - song by {artist} | {site['title']}"
        og_type, noun = "music.song", "song"
        meta = [m for m in ("" if item["single"] else item["album"], _mmss(item["duration"])) if m]
    elif kind == "album":
        desc = f"{item['label']} by {artist} · {_count(len(item['tracks']), 'song')}"
        page_title = f"{title} - {item['label'].lower()} by {artist} | {site['title']}"
        og_type, noun = "music.album", item["label"].lower()
        meta = [m for m in (_count(len(item["tracks"]), "song"), _long_duration(item["duration"])) if m]
    else:
        desc = "Artist · " + _count(item["songs"], "song")
        page_title = f"{title} | {site['title']}"
        og_type, noun = "profile", "artist"
        meta = [m for m in (_count(item["songs"], "song"), _count(len(item["albums"]), "release")) if m]
    music = []
    if kind == "track":
        if item["duration"]: music.append(("music:duration", str(int(round(item["duration"])))))
        if item["album_url"]: music.append(("music:album", base + item["album_url"]))
        music.append(("music:musician", base + item["artist_url"]))
    elif kind == "album":
        if item["artist_url"]: music.append(("music:musician", base + item["artist_url"]))
        music.append(("music:song_count", str(len(item["tracks"]))))
    stream = lambda t: "/api/stream_path?" + urllib.parse.urlencode({"path": t["rel_path"]}) if can_play else ""
    cover_url = f"/{kind}/{sid}/cover.jpg?v={ver}" if cover else ""
    # Songs on an artist page each show their own artwork; an album's songs share the album's.
    tcover = (lambda t: f"/track/{share_id('t', t['rel_path'])}/cover.jpg") if kind == "artist" else (lambda t: cover_url)
    data = {"kind": kind, "canPlay": can_play, "title": title, "artist": artist, "cover": cover_url,
            "tracks": [{"t": t.get("title") or Path(t["rel_path"]).stem, "a": t.get("display_artist") or t.get("artist") or "",
                        "d": t.get("duration") or 0, "src": stream(t), "c": tcover(t)} for t in item["tracks"]]}
    resp = Response(render_template(
        "share.html", missing=False, kind=kind, item=item, site=site, url=url, desc=desc, page_title=page_title, og_type=og_type,
        noun=noun, meta=meta, music=music, color=color, tint=f"{n >> 16}, {(n >> 8) & 255}, {n & 255}", can_play=can_play,
        signed_in=bool(get_current_user()), cover=data["cover"], card=f"{base}/{kind}/{sid}/card.jpg?v={ver}" if cover else "",
        image_alt=f"{title} by {artist}" if artist else title, open_url=f"/{kind}/{sid}/open", data=data,
        indexable=bool(c.get("allow_indexing")), mmss=_mmss, share_id=share_id, version=AXDIO_VERSION))
    resp.headers["Cache-Control"] = "no-cache"
    return resp

@app.route("/<any(track, album, artist):kind>/<sid>/cover.jpg")
def share_cover(kind, sid):
    item = _share_lookup(kind, sid)
    if not item or not _share_visible(): abort(404)
    cover = cover_file_for(item["cover_rel"])
    if not cover: return Response(DEFAULT_SVG_COVER, mimetype="image/svg+xml")
    return send_file(cover, mimetype="image/jpeg", max_age=86400)

@app.route("/<any(track, album, artist):kind>/<sid>/card.jpg")
def share_card_image(kind, sid):
    item = _share_lookup(kind, sid)
    if not item or not _share_visible(): abort(404)
    cover = cover_file_for(item["cover_rel"])
    if not cover: abort(404)
    card = share_card(cover, "circle" if kind == "artist" else "square")
    if card:
        try: os.utime(card)   # recently used previews survive pruning
        except OSError: pass
        return send_file(card, mimetype="image/jpeg", max_age=604800)
    return send_file(cover, mimetype="image/jpeg", max_age=3600)

@app.route("/<any(track, album, artist):kind>/<sid>/open")
def share_open(kind, sid):
    """Open a shared item in the web app (signing in first on a private server)."""
    item = _share_lookup(kind, sid)
    if not item: return _share_missing()
    at = request.args.get("t", 0, type=int)
    moment = f"&t={at}" if kind == "track" and 0 < at < 86400 else ""
    if cfg().get("require_login") and not get_current_user(): return redirect(f"/?next=/{kind}/{sid}/open" + (f"?t={at}" if moment else ""))
    return redirect(item["app"] + moment)


# ============================================================
# SOCIAL: friends, listening activity, profiles, collaborative playlists and private messages
# ============================================================
# Friends and privacy settings live in each account record under "social". Collaborative playlists,
# conversations and messages are tables in axdio.db.
#
# Messages are end-to-end encrypted by the web apps (web/app/core.js, section "Private messages"). Keys are
# made on the listener's devices; the server only stores and relays public keys, a recovery backup encrypted
# with a key the server never sees, signed group-membership events, conversation keys wrapped for each member,
# and message ciphertext. It can't read messages or group names, and nothing here needs to.
SOCIAL_LOCK = threading.RLock()
_SV_BASE = int(time.time())
_sv = {}          # per-account change counters the apps poll: f(riends), c(hats), p(laylists), l(ink requests)
_presence = {}    # username -> {"rel", "t", "playing"}: what each account is playing, from its players
_rates = {}

def bump(users, *areas):
    for u in ([users] if isinstance(users, str) else users):
        if not u: continue
        d = _sv.setdefault(u, {k: _SV_BASE for k in "fcpl"})
        for a in areas: d[a] += 1

def rate_ok(key, limit, window):
    now = time.time()
    q = _rates.setdefault(key, collections.deque())
    while q and now - q[0] > window: q.popleft()
    if len(q) >= limit: return False
    q.append(now)
    return True

def social_rec(rec):
    s = rec.setdefault("social", {})
    for k in ("friends", "in", "out", "blocked"): s.setdefault(k, [])
    s.setdefault("share_activity", True)
    s.setdefault("discoverable", True)
    return s

def user_card(u, rec=None):
    rec = rec if rec is not None else users_data.get(u) or {}
    return {"username": u, "display_name": rec.get("display_name") or u, "avatar": rec.get("avatar", "")}

def relation(me, other):
    s = social_rec(users_data[me])
    for state, key in (("friend", "friends"), ("incoming", "in"), ("outgoing", "out"), ("blocked", "blocked")):
        if other in s[key]: return state
    return "none"

def blocked_either(a, b):
    ra, rb = users_data.get(a), users_data.get(b)
    return bool(ra and rb and (b in social_rec(ra)["blocked"] or a in social_rec(rb)["blocked"]))

def _drop(lst, x):
    while x in lst: lst.remove(x)

def social_on(): return cfg().get("feature_social", True)
def chat_on(): return social_on() and cfg().get("feature_chat", True)
def collab_on(): return social_on() and cfg().get("feature_collab", True)

def note_presence(user, rel, playing, pos=None):
    if not user or user.startswith("guest@"): return
    rel = rel or (_presence.get(user) or {}).get("rel")
    if rel:
        _presence[user] = {"rel": rel, "t": time.time(), "playing": bool(playing), "pos": float(pos) if isinstance(pos, (int, float)) and 0 <= pos < 86400 else 0.0}

def _iso_ts(v):
    try: return datetime.fromisoformat(str(v)).timestamp()
    except (TypeError, ValueError): return 0

def listening_now(user, rec):
    """What a friend is (or was last) listening to, if they share their activity."""
    if not social_rec(rec)["share_activity"]: return None
    p, now = _presence.get(user), time.time()
    if p and now - p["t"] < 3 * 3600:
        rel, t, live = p["rel"], p["t"], p["playing"] and now - p["t"] < 90
    else:
        h = max(rec.get("history") or [], key=lambda x: x.get("last_played") or "", default=None)
        if not h or not h.get("rel_path"): return None
        rel, t, live = h["rel_path"], _iso_ts(h.get("last_played")), False
    with library_cache_lock: meta = library_cache_data.get(rel)
    if not isinstance(meta, dict): return None
    return {"rel": rel, "title": meta.get("title") or Path(rel).stem, "artist": meta.get("artist") or "",
            "album": meta.get("album") or "", "t": t, "live": live}

# --- Friends ---
@app.route("/api/social/me")
def social_me():
    u = _me()
    with users_lock:
        s = social_rec(users_data[u])
        cards = lambda key: [user_card(x) for x in s[key] if x in users_data]
        return jsonify({"friends": cards("friends"), "incoming": cards("in"), "outgoing": cards("out"), "blocked": cards("blocked"),
                        "settings": {"share_activity": s["share_activity"], "discoverable": s["discoverable"]}})

@app.route("/api/social/search")
def social_search():
    u = _me()
    q = (request.args.get("q") or "").strip().lower()[:40]
    if len(q) < 2: return jsonify({"users": []})
    found = []
    with users_lock:
        for name, rec in users_data.items():
            if name == u or rec.get("disabled"): continue
            s = social_rec(rec)
            if u in s["blocked"]: continue
            dn = str(rec.get("display_name") or "").lower()
            rank = 0 if name == q else 1 if name.startswith(q) else 2 if q in dn else None
            if rank is None or (rank and not s["discoverable"]): continue
            found.append((rank, name, dict(user_card(name, rec), state=relation(u, name))))
    found.sort(key=lambda x: (x[0], x[1]))
    return jsonify({"users": [f[2] for f in found[:20]]})

def _make_friends(a, b):
    sa, sb = social_rec(users_data[a]), social_rec(users_data[b])
    for s, x in ((sa, b), (sb, a)):
        _drop(s["in"], x); _drop(s["out"], x)
        if x not in s["friends"]: s["friends"].append(x)

@app.route("/api/social/friends/<action>", methods=["POST"])
def social_friend_action(action):
    u = _me()
    if action not in ("request", "accept", "decline", "cancel", "remove", "block", "unblock"): abort(404)
    other = str(_json().get("username") or "").strip().lower()
    if action == "request" and not rate_ok(("friend", u), 60, 3600):
        return jsonify({"error": "You've sent a lot of friend requests. Try again later."}), 429
    with users_lock:
        if other == u or other not in users_data: return jsonify({"error": "There's no one with that username."}), 404
        me, them = social_rec(users_data[u]), social_rec(users_data[other])
        if action == "request":
            if other in me["blocked"] or u in them["blocked"]: return jsonify({"error": "You can't add this person."}), 403
            if other in me["in"]: _make_friends(u, other)
            elif other not in me["friends"] and other not in me["out"]:
                if len(me["out"]) >= 200: return jsonify({"error": "You have too many requests waiting. Cancel some first."}), 400
                me["out"].append(other); them["in"].append(u)
        elif action == "accept":
            if other not in me["in"]: return jsonify({"error": "That request isn't there anymore."}), 400
            _make_friends(u, other)
        elif action == "decline": _drop(me["in"], other); _drop(them["out"], u)
        elif action == "cancel": _drop(me["out"], other); _drop(them["in"], u)
        elif action == "remove": _drop(me["friends"], other); _drop(them["friends"], u)
        elif action == "block":
            for k in ("friends", "in", "out"): _drop(me[k], other); _drop(them[k], u)
            if other not in me["blocked"]: me["blocked"].append(other)
        elif action == "unblock": _drop(me["blocked"], other)
        save_users()
        state = relation(u, other)
    if action == "block": collab_unlink(u, other)
    bump([u, other], "f")
    return jsonify({"ok": True, "state": state})

@app.route("/api/social/settings", methods=["POST"])
def social_settings():
    u = _me()
    d = _json()
    with users_lock:
        s = social_rec(users_data[u])
        for k in ("share_activity", "discoverable"):
            if k in d: s[k] = bool(d[k])
        save_users(u)
        friends = list(s["friends"])
        out = {"share_activity": s["share_activity"], "discoverable": s["discoverable"]}
    bump(friends, "f")
    return jsonify(out)

@app.route("/api/social/activity")
def social_activity():
    u = _me()
    out = []
    with users_lock:
        for f in social_rec(users_data[u])["friends"]:
            rec = users_data.get(f)
            if rec and not rec.get("disabled"):
                out.append(dict(user_card(f, rec), now=listening_now(f, rec), sharing=social_rec(rec)["share_activity"],
                                party=party_badge(f, u) if party_on() else None))
    out.sort(key=lambda x: (not (x["now"] and x["now"]["live"]), -(x["now"]["t"] if x["now"] else 0), x["display_name"].lower()))
    return jsonify({"friends": out})

@app.route("/api/social/users/<username>")
def social_profile(username):
    u = _me()
    username = username.lower()
    with users_lock:
        rec = users_data.get(username)
        if not rec or rec.get("disabled") or u in social_rec(rec)["blocked"]: return jsonify({"error": "There's no one with that username."}), 404
        s, mine = social_rec(rec), social_rec(users_data[u])
        state = "self" if username == u else relation(u, username)
        out = dict(user_card(username, rec), state=state, since=str(rec.get("created") or "")[:10],
                   friends=len(s["friends"]), mutual=len(set(mine["friends"]) & set(s["friends"])) if state != "self" else 0)
        if state in ("friend", "self") and s["share_activity"]:
            out["now"] = listening_now(username, rec)
            hist = sorted(rec.get("history") or [], key=lambda h: h.get("last_played") or "", reverse=True)
            out["recent"] = [h["rel_path"] for h in hist[:24] if h.get("rel_path")]
            counts = Counter()
            with library_cache_lock:
                for h in hist[:600]:
                    meta = library_cache_data.get(h.get("rel_path"))
                    if isinstance(meta, dict):
                        counts[extract_primary_artist(meta.get("artist"), meta.get("album_artist"))] += h.get("count", 1)
            out["top_artists"] = [a for a, _ in counts.most_common(10) if a != "Unknown Artist"]
            if state == "friend" and mine["share_activity"]: out["blend"] = blend(users_data[u], rec)
    if achievements_on() and state in ("friend", "self") and s["share_activity"]:
        out["achievements"] = achievements_public(username)      # outside users_lock: it reads the database
    if collab_on():
        out["playlists"] = [pl_summary(pl) for pl in playlists_of(u) if username in pl_members(pl)] if state != "self" else []
    return jsonify(out)

# --- Blend: how two friends' tastes meet ---
import itertools, math
# Built only from what friends already share with each other (listening activity and likes), and only when both share it.
def _taste(rec):
    plays = Counter()
    for h in (rec.get("history") or [])[-1500:]:
        if h.get("rel_path"): plays[h["rel_path"]] += max(1, int(h.get("count") or 1))
    for rel in (rec.get("liked_songs") or [])[-3000:]:
        if isinstance(rel, str): plays[rel] += 3
    artists = Counter()
    with library_cache_lock:
        for rel in list(plays):
            meta = library_cache_data.get(rel)
            if not isinstance(meta, dict): del plays[rel]; continue
            a = extract_primary_artist(meta.get("artist"), meta.get("album_artist"))
            if a != "Unknown Artist": artists[a] += plays[rel]
    return plays, artists

def blend(me_rec, them_rec, size=50):
    a_plays, a_art = _taste(me_rec)
    b_plays, b_art = _taste(them_rec)
    if len(a_plays) < 3 or len(b_plays) < 3: return None
    dot = sum(a_art[x] * b_art[x] for x in a_art.keys() & b_art.keys())
    norm = math.sqrt(sum(v * v for v in a_art.values()) * sum(v * v for v in b_art.values())) or 1
    match = round(100 * (dot / norm) ** 0.6)
    ta, tb = sum(a_art.values()) or 1, sum(b_art.values()) or 1
    common = sorted(a_art.keys() & b_art.keys(), key=lambda x: -min(a_art[x] / ta, b_art[x] / tb))[:5]
    both = sorted(a_plays.keys() & b_plays.keys(), key=lambda r: -(a_plays[r] + b_plays[r]))
    mine = [r for r, _ in a_plays.most_common(200) if r not in b_plays]
    theirs = [r for r, _ in b_plays.most_common(200) if r not in a_plays]
    rels, seen = [], set()
    for group in (both[:size // 2], [x for pair in itertools.zip_longest(theirs, mine) for x in pair if x]):
        for r in group:
            if r not in seen and len(rels) < size: seen.add(r); rels.append(r)
    return {"match": max(0, min(100, match)), "common": common, "rels": rels, "shared_songs": len(both)}

@app.route("/api/social/pulse")
def social_pulse():
    u = _me()
    d = dict(_sv.get(u) or {k: _SV_BASE for k in "fcpl"})
    with users_lock: d["requests"] = len(social_rec(users_data[u])["in"])
    d["unread"] = chat_unread(u) if chat_on() else 0
    d["links"] = sum(1 for l in _links.values() if l["user"] == u and l["state"] == "pending" and time.time() - l["created"] < LINK_TTL)
    return jsonify(d)

def social_version(u):
    """One number that changes whenever anything social changes for this account (sent with Connect heartbeats)."""
    return sum((_sv.get(u) or {}).values())

# --- Music notes: a line and a song for friends, for 24 hours ---
NOTE_TTL = 86400

def notes_on(): return social_on() and bool(cfg().get("feature_notes", True))

def note_view(u):
    rec = users_data.get(u) or {}
    n = rec.get("note")
    if not n or n.get("until", 0) <= time.time(): return None
    out = {"text": n.get("text") or "", "ts": n["ts"], "until": n["until"]}
    meta = library_entry(n["rel"]) if n.get("rel") else None
    if isinstance(meta, dict): out.update(rel=n["rel"], title=meta.get("title") or Path(n["rel"]).stem, artist=meta.get("artist") or "")
    return out

@app.route("/api/social/note", methods=["POST"])
def social_note():
    u = _me()
    if not notes_on(): return jsonify({"error": "Notes are turned off on this server.", "disabled": True}), 403
    d = _json()
    text = re.sub(r"\s+", " ", str(d.get("text") or "")).strip()[:60]
    rel = d.get("rel") if isinstance(d.get("rel"), str) and isinstance(library_entry(d.get("rel")), dict) else None
    with users_lock:
        rec = users_data[u]
        if d.get("clear") or (not text and not rel): rec.pop("note", None)
        else:
            if not rate_ok(("note", u), 40, 3600): return jsonify({"error": "That's a lot of notes. Try again later."}), 429
            rec["note"] = {"text": text, "rel": rel, "ts": time.time(), "until": time.time() + NOTE_TTL}
        save_users(u)
        friends = list(social_rec(rec)["friends"])
        mine = note_view(u)
    bump(friends + [u], "f")
    return jsonify({"note": mine})

@app.route("/api/social/notes")
def social_notes():
    """The listener's own note and their friends' current ones, newest first."""
    u = _me()
    if not notes_on(): return jsonify({"mine": None, "friends": [], "off": True})
    out = []
    with users_lock:
        for f in social_rec(users_data[u])["friends"]:
            rec = users_data.get(f)
            if not rec or blocked_either(u, f): continue
            n = note_view(f)
            if n: out.append(dict(user_card(f, rec), note=n))
        mine = note_view(u)
    out.sort(key=lambda x: -x["note"]["ts"])
    return jsonify({"mine": mine, "friends": out})

# --- Collaborative playlists ---
# The owner invites friends; everyone on it can add, remove and reorder songs. Edits are operations on song
# paths rather than positions, so two people editing at the same time don't undo each other's changes.
PL_ID_RE = re.compile(r"^pl_[0-9A-Za-z]{12}$")
PL_MAX_TRACKS, PL_MAX_MEMBERS = 10000, 50

def pl_members(pl): return [pl["owner"]] + list(pl.get("collaborators") or [])

def _pl_rows(sql="SELECT data FROM shared_playlists", args=()):
    with _db_lock: rows = db().execute(sql, args).fetchall()
    out = []
    for (data,) in rows:
        try: out.append(json.loads(data))
        except ValueError: pass
    return out

def pl_load(pid):
    rows = _pl_rows("SELECT data FROM shared_playlists WHERE id = ?", (pid,)) if PL_ID_RE.match(pid or "") else []
    return rows[0] if rows else None

def pl_save(pl):
    pl["updated"] = time.time()
    pl["v"] = int(pl.get("v") or 0) + 1
    with _db_lock:
        db().execute("INSERT INTO shared_playlists (id, data, updated) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated=excluded.updated",
                     (pl["id"], json.dumps(pl), pl["updated"]))

def pl_delete(pid):
    with _db_lock: db().execute("DELETE FROM shared_playlists WHERE id = ?", (pid,))

def playlists_of(u): return [pl for pl in _pl_rows() if u in pl_members(pl)]

def pl_view(pl):
    with users_lock:
        names = set(pl_members(pl)) | {t.get("by") for t in pl["tracks"]}
        cards = {n: user_card(n) for n in names if n in users_data}
    return dict(pl, people=cards)

def pl_summary(pl):
    return {"id": pl["id"], "name": pl["name"], "owner": pl["owner"], "tracks": len(pl["tracks"]),
            "cover": [t["r"] for t in pl["tracks"][:40]]}

def _rels(v, cap=PL_MAX_TRACKS):
    out, seen = [], set()
    for r in v if isinstance(v, list) else []:
        if isinstance(r, str) and 0 < len(r) <= 1024 and r not in seen:
            seen.add(r); out.append(r)
        if len(out) >= cap: break
    return out

def _invitable(owner, users, current):
    with users_lock:
        friends = set(social_rec(users_data[owner])["friends"])
    return [x for x in dict.fromkeys(str(v).lower() for v in users if isinstance(v, str)) if x in friends and x not in current]

@app.route("/api/social/playlists", methods=["GET", "POST"])
def social_playlists():
    u = _me()
    if request.method == "GET":
        return jsonify({"playlists": [pl_view(pl) for pl in playlists_of(u)]})
    d = _json()
    name = re.sub(r"\s+", " ", str(d.get("name") or "")).strip()[:100]
    if not name: return jsonify({"error": "Give the playlist a name."}), 400
    with SOCIAL_LOCK:
        if sum(1 for pl in _pl_rows() if pl["owner"] == u) >= 200: return jsonify({"error": "You can own up to 200 collaborative playlists."}), 400
        now = time.time()
        pl = {"id": "pl_" + "".join(secrets.choice(_B62) for _ in range(12)), "name": name, "owner": u,
              "collaborators": _invitable(u, d.get("collaborators") or [], {u})[:PL_MAX_MEMBERS - 1],
              "tracks": [{"r": r, "by": u, "at": now} for r in _rels(d.get("tracks"))], "created": now}
        pl_save(pl)
    bump(pl_members(pl), "p")
    return jsonify(pl_view(pl))

@app.route("/api/social/playlists/<pid>", methods=["POST"])
def social_playlist_op(pid):
    u = _me()
    d = _json()
    op = d.get("op")
    with SOCIAL_LOCK:
        pl = pl_load(pid)
        if not pl or u not in pl_members(pl): return jsonify({"error": "That playlist isn't available."}), 404
        owner, before, now = pl["owner"] == u, set(pl_members(pl)), time.time()
        if op in ("rename", "invite", "kick", "delete") and not owner:
            return jsonify({"error": "Only the playlist's owner can do that."}), 403
        tracks = pl["tracks"]
        if op == "add":
            have = {t["r"] for t in tracks}
            new = [{"r": r, "by": u, "at": now} for r in _rels(d.get("rels"), PL_MAX_TRACKS - len(tracks)) if r not in have]
            at = next((i for i, t in enumerate(tracks) if t["r"] == d.get("before")), len(tracks))
            tracks[at:at] = new
        elif op == "remove":
            drop = set(_rels(d.get("rels")))
            pl["tracks"] = [t for t in tracks if t["r"] not in drop]
        elif op == "move":
            item = next((t for t in tracks if t["r"] == d.get("rel")), None)
            if item and d.get("before") != item["r"]:
                tracks.remove(item)
                at = next((i for i, t in enumerate(tracks) if t["r"] == d.get("before")), len(tracks))
                tracks.insert(at, item)
        elif op == "rename":
            name = re.sub(r"\s+", " ", str(d.get("name") or "")).strip()[:100]
            if not name: return jsonify({"error": "Give the playlist a name."}), 400
            pl["name"] = name
        elif op == "invite":
            add = _invitable(u, d.get("users") or [], set(pl_members(pl)))
            pl["collaborators"] = (pl["collaborators"] + add)[:PL_MAX_MEMBERS - 1]
        elif op == "kick":
            _drop(pl["collaborators"], str(d.get("user") or ""))
        elif op == "leave":
            if owner: return jsonify({"error": "You own this playlist. Delete it instead."}), 400
            _drop(pl["collaborators"], u)
        elif op == "delete":
            pl_delete(pid)
            bump(before, "p")
            return jsonify({"ok": True, "deleted": True})
        else:
            return jsonify({"error": "Unknown change."}), 400
        pl_save(pl)
    bump(before | set(pl_members(pl)), "p")
    return jsonify(pl_view(pl))

def collab_unlink(a, b):
    """After a block: take each out of the other's collaborative playlists."""
    with SOCIAL_LOCK:
        for pl in _pl_rows():
            if (pl["owner"] == a and b in pl["collaborators"]) or (pl["owner"] == b and a in pl["collaborators"]):
                _drop(pl["collaborators"], b if pl["owner"] == a else a)
                pl_save(pl)
                bump([a, b] + pl_members(pl), "p")

# --- Private messages ---
# Conversation ids: "dm_" + a hash of the two usernames (so a pair has one chat), or "gr_" + a random id the
# creating app picks (it signs the group's first event with it). Everything else a client sends is opaque:
# base64url public keys, wrapped keys, IVs, ciphertext and signatures, which are size-checked and stored as is.
CONV_ID_RE = re.compile(r"^(dm_[0-9a-f]{24}|gr_[0-9A-Za-z_-]{22}|sc_[0-9A-Za-z_-]{22})$")
MSG_ID_RE = re.compile(r"^[0-9A-Za-z_-]{16,32}$")
_B64 = re.compile(r"^[0-9A-Za-z_-]*$")
PUBKEY_LEN = 87          # a P-256 public key (65 bytes) in base64url
LINK_TTL = 600
_links = {}              # device-link requests: id -> {"user", "pub", "device", "created", "state", "x", "blob"}

def _b64(v, lo, hi): return isinstance(v, str) and lo <= len(v) <= hi and bool(_B64.match(v))

def _sealed(v, max_ct=8000):
    """{iv, ct} as sent by the apps: a 12-byte IV and AES-GCM ciphertext, both base64url."""
    return isinstance(v, dict) and _b64(v.get("iv"), 16, 16) and _b64(v.get("ct"), 22, max_ct)

def e2ee_public(rec):
    e = rec.get("e2ee")
    return {"enc": e["enc"], "sig": e["sig"], "fp": e["fp"], "v": e.get("v", 1)} if e else None

@app.route("/api/chat/keys", methods=["GET", "POST"])
def chat_keys():
    u = _me()
    if request.method == "GET":
        names = [n for n in (request.args.get("users") or "").lower().split(",")[:100] if USERNAME_RE.match(n)]
        with users_lock:
            return jsonify({"keys": {n: e2ee_public(users_data[n]) if n in users_data else None for n in names}})
    d = _json()
    if not (_b64(d.get("enc"), PUBKEY_LEN, PUBKEY_LEN) and _b64(d.get("sig"), PUBKEY_LEN, PUBKEY_LEN)
            and re.fullmatch(r"[0-9a-f]{64}", str(d.get("fp") or "")) and _sealed(d.get("backup"), 4000)
            and _b64((d.get("backup") or {}).get("salt"), 22, 22)):
        return jsonify({"error": "Those keys aren't in the expected format."}), 400
    with users_lock:
        rec = users_data[u]
        cur = rec.get("e2ee")
        if cur and cur["fp"] != d["fp"] and not d.get("reset"):
            return jsonify({"error": "Private messages are already set up for this account.", "exists": True}), 409
        rec["e2ee"] = {"enc": d["enc"], "sig": d["sig"], "fp": d["fp"], "created": time.time(),
                       "v": (cur.get("v", 1) + (cur["fp"] != d["fp"])) if cur else 1,
                       "backup": {k: d["backup"][k] for k in ("salt", "iv", "ct")}}
        save_users(u)
        friends = list(social_rec(rec)["friends"])
    if cur and cur["fp"] != d["fp"]:
        activity("account", "Reset their message keys; messages sent before can't be read on their devices anymore", u)
        bump([u] + friends + conversation_peers(u), "c", "f")
    return jsonify({"ok": True})

@app.route("/api/chat/backup", methods=["GET", "POST"])
def chat_backup():
    u = _me()
    with users_lock:
        e = users_data[u].get("e2ee")
        if not e: return jsonify({"error": "Private messages aren't set up yet."}), 404
        if request.method == "POST":
            b = _json().get("backup")
            if not (_sealed(b, 4000) and _b64(b.get("salt"), 22, 22)): return jsonify({"error": "Bad backup."}), 400
            e["backup"] = {k: b[k] for k in ("salt", "iv", "ct")}
            save_users(u)
        return jsonify({"backup": e.get("backup"), "fp": e["fp"]})

def _purge_links():
    for lid in [k for k, v in _links.items() if time.time() - v["created"] > LINK_TTL]: _links.pop(lid, None)

@app.route("/api/chat/link", methods=["POST"])
def chat_link_create():
    """A new device asks the account's other devices for its message keys."""
    u = _me()
    pub = _json().get("pub")
    if not _b64(pub, PUBKEY_LEN, PUBKEY_LEN): return jsonify({"error": "Bad key."}), 400
    _purge_links()
    if sum(1 for l in _links.values() if l["user"] == u) >= 5 or not rate_ok(("link", u), 20, 3600):
        return jsonify({"error": "Too many devices are waiting. Try again in a few minutes."}), 429
    lid = secrets.token_urlsafe(12)
    _links[lid] = {"user": u, "pub": pub, "device": device_label(request.headers.get("User-Agent", "")), "created": time.time(), "state": "pending"}
    bump(u, "l")
    return jsonify({"id": lid, "expires": _links[lid]["created"] + LINK_TTL})

@app.route("/api/chat/links")
def chat_links():
    u = _me()
    _purge_links()
    return jsonify({"links": [{"id": k, "pub": v["pub"], "device": v["device"], "created": v["created"]}
                              for k, v in _links.items() if v["user"] == u and v["state"] == "pending"]})

@app.route("/api/chat/link/<lid>", methods=["GET"])
def chat_link_state(lid):
    u = _me()
    l = _links.get(lid)
    if not l or l["user"] != u or time.time() - l["created"] > LINK_TTL: return jsonify({"state": "expired"})
    return jsonify({"state": l["state"], **({"x": l["x"], "blob": l["blob"]} if l["state"] == "approved" else {})})

@app.route("/api/chat/link/<lid>/<action>", methods=["POST"])
def chat_link_answer(lid, action):
    u = _me()
    l = _links.get(lid)
    if not l or l["user"] != u or l["state"] != "pending" or time.time() - l["created"] > LINK_TTL:
        return jsonify({"error": "That request has expired."}), 404
    if action == "approve":
        d = _json()
        if not (_b64(d.get("x"), PUBKEY_LEN, PUBKEY_LEN) and _sealed(d.get("blob"), 4000)): return jsonify({"error": "Bad keys."}), 400
        l.update(state="approved", x=d["x"], blob={"iv": d["blob"]["iv"], "ct": d["blob"]["ct"]})
        activity("account", f"Linked a new device for private messages ({l['device']})", u)
    elif action == "deny": l["state"] = "denied"
    else: abort(404)
    bump(u, "l")
    return jsonify({"ok": True})

def conv_load(cid):
    if not CONV_ID_RE.match(cid or ""): return None
    with _db_lock: row = db().execute("SELECT data FROM conversations WHERE id = ?", (cid,)).fetchone()
    return json.loads(row[0]) if row else None

def conv_save(c):
    c["updated"] = time.time()
    with _db_lock:
        conn = db()
        conn.execute("BEGIN")
        try:
            conn.execute("INSERT INTO conversations (id, data, updated) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated=excluded.updated",
                         (c["id"], json.dumps(c), c["updated"]))
            have = {r[0] for r in conn.execute("SELECT user FROM conv_members WHERE conv = ?", (c["id"],))}
            keep = set(c["members"]) - set(c.get("gone") or [])
            conn.executemany("INSERT INTO conv_members (conv, user) VALUES (?, ?)", [(c["id"], m) for m in keep - have])
            conn.executemany("DELETE FROM conv_members WHERE conv = ? AND user = ?", [(c["id"], m) for m in have - keep])
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise

def conversation_peers(u):
    with _db_lock:
        rows = db().execute("SELECT DISTINCT o.user FROM conv_members m JOIN conv_members o ON o.conv = m.conv WHERE m.user = ? AND o.user != ?", (u, u)).fetchall()
    return [r[0] for r in rows]

def chat_unread(u):
    with _db_lock:
        row = db().execute("SELECT COUNT(*) FROM messages msg JOIN conv_members m ON m.conv = msg.conv AND m.user = ? "
                           "WHERE msg.seq > m.read_seq AND msg.sender != ? AND msg.seq > m.hidden_seq AND msg.data NOT LIKE '%\"deleted\": true%'", (u, u)).fetchone()
    return row[0] if row else 0

def _msg_out(seq, sender, ts, data, expires=None):
    out = dict(json.loads(data), seq=seq, sender=sender, ts=ts)
    if expires: out["expires"] = expires
    return out

def conv_views(u, cids=None):
    """The listener's conversations with their people, keys, read markers, newest message and unread count."""
    with _db_lock:
        conn = db()
        mine = conn.execute("SELECT conv, read_seq, hidden_seq FROM conv_members WHERE user = ?", (u,)).fetchall()
        mine = {r[0]: (r[1], r[2]) for r in mine if cids is None or r[0] in cids}
        if not mine: return []
        marks = ",".join("?" * len(mine))
        ids = list(mine)
        convs = {cid: json.loads(data) for cid, data in conn.execute(f"SELECT id, data FROM conversations WHERE id IN ({marks})", ids)}
        reads = collections.defaultdict(dict)
        for cid, user, seq in conn.execute(f"SELECT conv, user, read_seq FROM conv_members WHERE conv IN ({marks})", ids): reads[cid][user] = seq
        last = {cid: _msg_out(seq, sender, ts, data) for cid, seq, sender, ts, data in conn.execute(
            f"SELECT m.conv, m.seq, m.sender, m.ts, m.data FROM messages m JOIN (SELECT conv, MAX(seq) s FROM messages WHERE conv IN ({marks}) GROUP BY conv) t "
            "ON m.conv = t.conv AND m.seq = t.s", ids)}
        unsent = collections.defaultdict(list)
        for cid, mid in conn.execute(f"SELECT conv, id FROM messages WHERE conv IN ({marks}) AND ts > ? AND data LIKE '%\"deleted\": true%'", ids + [time.time() - 7 * 86400]):
            unsent[cid].append(mid)
        unread = dict(conn.execute(f"SELECT m.conv, COUNT(*) FROM messages m JOIN conv_members c ON c.conv = m.conv AND c.user = ? WHERE m.conv IN ({marks}) "
                                   "AND m.seq > c.read_seq AND m.seq > c.hidden_seq AND m.sender != ? AND m.data NOT LIKE '%\"deleted\": true%' GROUP BY m.conv",
                                   [u] + ids + [u]).fetchall())
    out = []
    with users_lock:
        for cid, c in convs.items():
            read_seq, hidden = mine[cid]
            lm = last.get(cid)
            if cids is None and c["kind"] == "dm" and hidden and (not lm or lm["seq"] <= hidden): continue
            people = set(c["members"]) | {e.get("by") for e in c.get("events", [])} | {e.get("user") for e in c.get("events", [])}
            out.append(dict(c, reads=reads[cid], last=lm if lm and lm["seq"] > hidden else None, unread=unread.get(cid, 0), hidden=hidden, unsent=unsent[cid],
                            people={p: dict(user_card(p), keys=e2ee_public(users_data[p])) for p in people if p in users_data}))
    out.sort(key=lambda c: -((c["last"] or {}).get("ts") or c.get("created") or 0))
    return out

def _conv_or_404(cid, u):
    c = conv_load(cid)
    if not c or u not in c["members"] or u in (c.get("gone") or []): abort(Response(json.dumps({"error": "That conversation isn't available."}), 404, mimetype="application/json"))
    return c

@app.route("/api/chat/conversations")
def chat_conversations():
    return jsonify({"conversations": conv_views(_me())})

@app.route("/api/chat/<cid>")
def chat_conversation(cid):
    u = _me()
    _conv_or_404(cid, u)
    return jsonify(conv_views(u, {cid})[0])

@app.route("/api/chat/dm", methods=["POST"])
def chat_dm():
    u = _me()
    other = str(_json().get("username") or "").lower()
    with users_lock:
        if other not in users_data or other == u: return jsonify({"error": "There's no one with that username."}), 404
        if blocked_either(u, other): return jsonify({"error": "You can't message this person."}), 403
        known = relation(u, other) == "friend"
    a, b = sorted([u, other])
    cid = "dm_" + hashlib.sha256(f"{a}\0{b}".encode()).hexdigest()[:24]
    with SOCIAL_LOCK:
        c = conv_load(cid)
        if not c:
            if not known: return jsonify({"error": "You can message people once you're friends."}), 403
            c = {"id": cid, "kind": "dm", "members": [a, b], "created_by": u, "created": time.time(), "events": [], "keys": []}
            conv_save(c)
            bump([a, b], "c")
        elif u in (c.get("gone") or []) or other in (c.get("gone") or []):
            return jsonify({"error": "This account no longer exists."}), 404
    return jsonify(conv_views(u, {cid})[0])

# --- Secret chats: one device each ---
# Like a direct message, but its keys are sealed to one device on each side instead of to the accounts: the device that
# started it and the one the other person first opens it on. Other devices signed in to either account (and anyone who
# learns a password or recovery key) can't read it. Each device key is vouched for by its account's signing key, which
# the apps check, and the key changes in the chat must be signed by one of its two devices. The server records which
# devices those are, once, and refuses keys from any other device of the same account.
DEVICE_ID_RE = re.compile(r"^[0-9A-Za-z_-]{16}$")

def _device_ok(dev):
    return (isinstance(dev, dict) and DEVICE_ID_RE.match(str(dev.get("id") or "")) and _b64(dev.get("enc"), PUBKEY_LEN, PUBKEY_LEN)
            and _b64(dev.get("sig"), PUBKEY_LEN, PUBKEY_LEN) and _b64(dev.get("cert"), 40, 200) and len(str(dev.get("label") or "")) <= 80)

def _device(dev):
    return {k: str(dev.get(k) or "")[:200] for k in ("id", "enc", "sig", "cert", "label")}

@app.route("/api/chat/secret", methods=["POST"])
def chat_secret():
    u = _me()
    d = _json()
    other = str(d.get("username") or "").lower()
    if not _device_ok(d.get("device")): return jsonify({"error": "This device's keys aren't in the expected format."}), 400
    with users_lock:
        if other not in users_data or other == u: return jsonify({"error": "There's no one with that username."}), 404
        if blocked_either(u, other): return jsonify({"error": "You can't message this person."}), 403
        if relation(u, other) != "friend": return jsonify({"error": "You can start a secret chat once you're friends."}), 403
    if not rate_ok(("secret", u), 30, 3600): return jsonify({"error": "You've started a lot of secret chats. Try again later."}), 429
    cid = "sc_" + secrets.token_urlsafe(16)
    with SOCIAL_LOCK:
        c = {"id": cid, "kind": "secret", "members": sorted([u, other]), "created_by": u, "created": time.time(), "events": [], "keys": [],
             "devices": {u: _device(d["device"])}}
        conv_save(c)
    bump([u, other], "c")
    return jsonify(conv_views(u, {cid})[0])

@app.route("/api/chat/<cid>/accept", methods=["POST"])
def chat_secret_accept(cid):
    """The other person opens a secret chat on the device that will be its only one on their side."""
    u = _me()
    dev = _json().get("device")
    if not _device_ok(dev): return jsonify({"error": "This device's keys aren't in the expected format."}), 400
    with SOCIAL_LOCK:
        c = _conv_or_404(cid, u)
        if c["kind"] != "secret": return jsonify({"error": "That isn't a secret chat."}), 400
        if u in c["devices"]: return jsonify({"error": "This secret chat is already open on another of your devices.", "elsewhere": True}), 409
        c["devices"][u] = _device(dev)
        conv_save(c)
    bump(c["members"], "c")
    return jsonify(conv_views(u, {cid})[0])

def _event_ok(ev, u, n):
    return (isinstance(ev, dict) and ev.get("by") == u and ev.get("n") == n and ev.get("t") in ("create", "add", "remove", "leave", "title")
            and _b64(ev.get("sig"), 40, 200) and _b64(ev.get("prev", ""), 0, 43) and isinstance(ev.get("ts"), int) and len(json.dumps(ev)) < 12000)

def group_admin(c):
    """The creator while they're in the group, else whoever joined earliest (members are kept in join order)."""
    return c["members"][0] if c["members"] else None

@app.route("/api/chat/groups", methods=["POST"])
def chat_group_create():
    u = _me()
    ev = _json().get("event") or {}
    cid, members = ev.get("conv"), ev.get("members")
    if not (_event_ok(ev, u, 0) and ev.get("t") == "create" and isinstance(cid, str) and cid.startswith("gr_") and CONV_ID_RE.match(cid)
            and isinstance(members, list) and members and members[0] == u and len(set(members)) == len(members)):
        return jsonify({"error": "That group couldn't be created."}), 400
    limit = int(cfg().get("chat_group_max") or 32)
    if not 3 <= len(members) <= limit: return jsonify({"error": f"Groups have 3 to {limit} people."}), 400
    with users_lock:
        friends = set(social_rec(users_data[u])["friends"])
    if any(m not in friends for m in members[1:]): return jsonify({"error": "You can only add friends to a group."}), 403
    with SOCIAL_LOCK:
        if conv_load(cid): return jsonify({"error": "That group already exists."}), 409
        if not rate_ok(("group", u), 30, 3600): return jsonify({"error": "You've made a lot of groups. Try again later."}), 429
        c = {"id": cid, "kind": "group", "members": members, "created_by": u, "created": time.time(), "events": [ev], "keys": []}
        conv_save(c)
    bump(members, "c")
    return jsonify(conv_views(u, {cid})[0])

@app.route("/api/chat/<cid>/events", methods=["POST"])
def chat_event(cid):
    u = _me()
    ev = _json().get("event") or {}
    with SOCIAL_LOCK:
        c = _conv_or_404(cid, u)
        before = set(c["members"])
        if c["kind"] != "group" or not _event_ok(ev, u, len(c["events"])) or ev.get("conv") != cid:
            return jsonify({"error": "That change couldn't be made.", "stale": True}), 409
        t, target = ev["t"], ev.get("user")
        if t == "add":
            with users_lock: ok = target in social_rec(users_data[u])["friends"] and target not in c["members"]
            if not ok: return jsonify({"error": "You can only add friends who aren't in the group yet."}), 403
            if len(c["members"]) >= int(cfg().get("chat_group_max") or 32): return jsonify({"error": "This group is full."}), 400
            c["members"].append(target)
        elif t == "remove":
            if group_admin(c) != u or target not in c["members"] or target == u: return jsonify({"error": "Only the group's admin can remove people."}), 403
            c["members"].remove(target)
        elif t == "leave":
            c["members"].remove(u)
        elif t == "title":
            if not _sealed(ev.get("title"), 800) or not isinstance(ev.get("v"), int): return jsonify({"error": "Bad name."}), 400
        else:
            return jsonify({"error": "That change couldn't be made."}), 400
        c["events"].append(ev)
        conv_save(c)
    bump(before | set(c["members"]), "c")
    return jsonify(conv_views(u, {cid})[0] if u in c["members"] else {"ok": True, "left": True})

@app.route("/api/chat/<cid>/keys", methods=["POST"])
def chat_conv_key(cid):
    u = _me()
    k = _json().get("key") or {}
    with SOCIAL_LOCK:
        c = _conv_or_404(cid, u)
        members = [m for m in c["members"] if m not in (c.get("gone") or [])]
        latest = c["keys"][-1]["v"] if c["keys"] else 0
        wraps, fps = k.get("wraps"), k.get("fps")
        if k.get("v") != latest + 1 or k.get("ev") != len(c["events"]) or sorted(k.get("members") or []) != sorted(members):
            return jsonify({"error": "Someone changed this conversation. Try again.", "stale": True, "conv": conv_views(u, {cid})[0]}), 409
        if not (k.get("by") == u and k.get("conv") == cid and isinstance(k.get("ts"), int) and _b64(k.get("sig"), 40, 200)
                and isinstance(wraps, dict) and set(wraps) == set(members) and isinstance(fps, dict) and set(fps) == set(members)
                and all(_sealed(w, 120) and _b64(w.get("e"), PUBKEY_LEN, PUBKEY_LEN) for w in wraps.values())
                and all(re.fullmatch(r"[0-9a-f]{64}", str(f)) for f in fps.values())):
            return jsonify({"error": "That key couldn't be saved."}), 400
        fields = ("v", "conv", "by", "ts", "ev", "members", "wraps", "fps", "sig")
        if c["kind"] == "secret":
            devs = c.get("devices") or {}
            if set(devs) != set(members): return jsonify({"error": "Waiting for the other person to open this secret chat."}), 409
            if k.get("dev") != devs[u]["id"] or not _b64(k.get("dsig"), 40, 200):
                return jsonify({"error": "This secret chat is open on another of your devices.", "elsewhere": True}), 403
            fields += ("dev", "dsig")
        c["keys"].append({x: k[x] for x in fields})
        conv_save(c)
    bump(members, "c")
    return jsonify(conv_views(u, {cid})[0])

@app.route("/api/chat/<cid>/messages", methods=["GET", "POST"])
def chat_messages(cid):
    u = _me()
    c = _conv_or_404(cid, u)
    if request.method == "GET":
        after, before = request.args.get("after", type=int), request.args.get("before", type=int)
        limit = max(1, min(100, request.args.get("limit", 50, type=int)))
        with _db_lock:
            hidden = (db().execute("SELECT hidden_seq FROM conv_members WHERE conv = ? AND user = ?", (cid, u)).fetchone() or (0,))[0]
            live = time.time()
            if after is not None:
                rows = db().execute("SELECT seq, sender, ts, data, expires FROM messages WHERE conv = ? AND seq > ? AND seq > ? AND (expires IS NULL OR expires > ?) "
                                    "ORDER BY seq LIMIT ?", (cid, after, hidden, live, limit)).fetchall()
            else:
                rows = db().execute("SELECT seq, sender, ts, data, expires FROM messages WHERE conv = ? AND seq < ? AND seq > ? AND (expires IS NULL OR expires > ?) "
                                    "ORDER BY seq DESC LIMIT ?", (cid, before or 2 ** 62, hidden, live, limit)).fetchall()[::-1]
        return jsonify({"messages": [_msg_out(*r) for r in rows], "more": after is None and len(rows) == limit})
    d = _json()
    latest = c["keys"][-1]["v"] if c["keys"] else 0
    if c["kind"] in ("dm", "secret"):
        other = next(m for m in c["members"] if m != u)
        with users_lock:
            if other in (c.get("gone") or []) or other not in users_data: return jsonify({"error": "This account no longer exists."}), 404
            if blocked_either(u, other): return jsonify({"error": "You can't message this person."}), 403
    if not latest or d.get("v") != latest:
        return jsonify({"error": "This conversation's key changed. Try again.", "stale": True, "conv": conv_views(u, {cid})[0]}), 409
    if not (MSG_ID_RE.match(str(d.get("id") or "")) and _sealed(d, 24000) and _b64(d.get("sig"), 40, 200)):
        return jsonify({"error": "That message couldn't be sent."}), 400
    files = d.get("files") or []
    if not (isinstance(files, list) and len(files) <= 10 and all(isinstance(f, str) and FILE_ID_RE.match(f) for f in files)):
        return jsonify({"error": "That message couldn't be sent."}), 400
    if not rate_ok(("msg", u), 120, 60): return jsonify({"error": "You're sending messages too fast. Wait a moment."}), 429
    ts = time.time()
    ttl = int(c.get("ttl") or 0)
    expires = ts + ttl if ttl else None
    data = json.dumps({"id": d["id"], "v": d["v"], "iv": d["iv"], "ct": d["ct"], "sig": d["sig"]})
    with _db_lock:
        conn = db()
        conn.execute("BEGIN")
        try:
            if files:
                marks = ",".join("?" * len(files))
                ok = conn.execute(f"SELECT COUNT(*) FROM files WHERE id IN ({marks}) AND conv = ? AND sender = ? AND ready = 1 AND msg IS NULL",
                                  files + [cid, u]).fetchone()[0]
                if ok != len(set(files)):
                    conn.execute("ROLLBACK")
                    return jsonify({"error": "An attachment is missing. Try sending it again."}), 400
                conn.execute(f"UPDATE files SET msg = ? WHERE id IN ({marks})", [d["id"]] + files)
            cur = conn.execute("INSERT INTO messages (id, conv, sender, ts, data, expires) VALUES (?, ?, ?, ?, ?, ?)", (d["id"], cid, u, ts, data, expires))
            seq = cur.lastrowid
            conn.execute("UPDATE conv_members SET read_seq = ? WHERE conv = ? AND user = ?", (seq, cid, u))
            conn.execute("COMMIT")
        except sqlite3.IntegrityError:
            conn.execute("ROLLBACK")
            return jsonify({"error": "That message was already sent."}), 409
        except Exception:
            conn.execute("ROLLBACK")
            raise
    bump(c["members"], "c")
    return jsonify({"message": _msg_out(seq, u, ts, data, expires)})

@app.route("/api/chat/<cid>/messages/<mid>", methods=["DELETE"])
def chat_message_delete(cid, mid):
    u = _me()
    c = _conv_or_404(cid, u)
    with _db_lock:
        row = db().execute("SELECT sender FROM messages WHERE conv = ? AND id = ?", (cid, mid)).fetchone()
        if not row: return jsonify({"error": "That message isn't there anymore."}), 404
        if row[0] != u: return jsonify({"error": "You can only unsend your own messages."}), 403
        db().execute("UPDATE messages SET data = ? WHERE conv = ? AND id = ?", (json.dumps({"id": mid, "deleted": True}), cid, mid))
    media_drop("msg = ?", (mid,))
    bump(c["members"], "c")
    return jsonify({"ok": True})

# --- Encrypted attachments ---
# Photos, videos and voice messages are encrypted on the sender's device with a key of their own, which travels inside
# the (end-to-end encrypted) message. The server gets numbered chunks of ciphertext, stores each as a file under
# CHAT_DIR/media, and hands them back to the conversation's members. It never sees the key, the file name or the type
# beyond "image", "video" or "voice", which it needs for the admin's limits.
CHAT_CHUNK = 512 * 1024           # plaintext bytes per chunk: small enough for default proxy body limits (nginx: 1 MB)
CHUNK_TAG = 16                    # AES-GCM adds a 16-byte tag to each chunk
FILE_ID_RE = re.compile(r"^[0-9A-Za-z_-]{22}$")
MEDIA_KINDS = {"image": "chat_media_images", "video": "chat_media_videos", "voice": "chat_media_voice"}
MB = 1024 * 1024

def media_max(): return max(1, int(cfg().get("chat_media_max_mb") or 100)) * MB

def media_dir(fid): return CHAT_MEDIA_DIR / fid[:2] / fid

def media_drop(where, args):
    """Forget attachments matching a WHERE clause on the files table, and remove their chunks."""
    with _db_lock:
        ids = [r[0] for r in db().execute(f"SELECT id FROM files WHERE {where}", args)]
        if ids: db().executemany("DELETE FROM files WHERE id = ?", [(i,) for i in ids])
    for fid in ids: shutil.rmtree(media_dir(fid), ignore_errors=True)
    return len(ids)

def _file_or_404(cid, fid):
    if not FILE_ID_RE.match(fid or ""): abort(404)
    with _db_lock:
        row = db().execute("SELECT sender, size, chunks, ready FROM files WHERE id = ? AND conv = ?", (fid, cid)).fetchone()
    if not row: abort(Response(json.dumps({"error": "That attachment isn't available anymore."}), 404, mimetype="application/json"))
    return row

def chunk_len(size, chunks, n):
    return (CHAT_CHUNK if n < chunks - 1 else size - CHAT_CHUNK * (chunks - 1)) + CHUNK_TAG

@app.route("/api/chat/<cid>/files", methods=["POST"])
def chat_file_create(cid):
    u = _me()
    c = _conv_or_404(cid, u)
    d = _json()
    kind, size = d.get("kind"), d.get("size")
    if kind not in MEDIA_KINDS: return jsonify({"error": "That kind of file can't be sent."}), 400
    if not cfg().get(MEDIA_KINDS[kind], True):
        return jsonify({"error": {"image": "Photos", "video": "Videos", "voice": "Voice messages"}[kind] + " are turned off on this server."}), 403
    if not isinstance(size, int) or size < 1: return jsonify({"error": "Bad size."}), 400
    if size > media_max(): return jsonify({"error": f"Attachments can be up to {media_max() // MB} MB on this server."}), 413
    if c["kind"] in ("dm", "secret"):
        other = next(m for m in c["members"] if m != u)
        with users_lock:
            if blocked_either(u, other): return jsonify({"error": "You can't message this person."}), 403
    quota = int(cfg().get("chat_media_quota_mb") or 0) * MB
    with _db_lock: used = db().execute("SELECT COALESCE(SUM(size), 0) FROM files WHERE sender = ?", (u,)).fetchone()[0]
    if quota and used + size > quota:
        return jsonify({"error": f"You've used your {quota // MB} MB for attachments. Unsend some older photos or videos to make room.", "quota": True}), 413
    if not rate_ok(("file", u), 120, 3600): return jsonify({"error": "You've sent a lot of attachments. Try again later."}), 429
    fid, chunks = secrets.token_urlsafe(16), -(-size // CHAT_CHUNK)
    media_dir(fid).mkdir(parents=True, exist_ok=True)
    with _db_lock:
        db().execute("INSERT INTO files (id, conv, sender, ts, kind, size, chunks) VALUES (?, ?, ?, ?, ?, ?, ?)", (fid, cid, u, time.time(), kind, size, chunks))
    return jsonify({"id": fid, "chunk": CHAT_CHUNK, "chunks": chunks})

@app.route("/api/chat/<cid>/files/<fid>/<int:n>", methods=["GET", "PUT"])
def chat_file_chunk(cid, fid, n):
    u = _me()
    _conv_or_404(cid, u)
    sender, size, chunks, ready = _file_or_404(cid, fid)
    if not 0 <= n < chunks: abort(404)
    path = media_dir(fid) / f"{n}.bin"
    if request.method == "GET":
        if not ready or not path.is_file(): abort(404)
        r = send_file(str(path), mimetype="application/octet-stream", conditional=True)
        r.headers["Cache-Control"] = "private, max-age=31536000, immutable"
        return r
    if sender != u or ready: return jsonify({"error": "That attachment can't be changed."}), 403
    want = chunk_len(size, chunks, n)
    if request.content_length not in (None, want): return jsonify({"error": "Wrong chunk size."}), 400
    tmp, got = path.with_suffix(f".{secrets.token_hex(4)}.part"), 0
    try:
        with open(tmp, "wb") as f:
            while True:
                piece = request.stream.read(min(65536, want + 1 - got))
                if not piece: break
                got += len(piece)
                if got > want: break
                f.write(piece)
        if got != want:
            tmp.unlink(missing_ok=True)
            return jsonify({"error": "Wrong chunk size."}), 400
        os.replace(tmp, path)
    except OSError as ex:
        tmp.unlink(missing_ok=True)
        print(f"[ERROR] Couldn't save an attachment chunk in {CHAT_MEDIA_DIR}: {ex}")
        return jsonify({"error": "The server couldn't store that attachment."}), 507
    return jsonify({"ok": True})

@app.route("/api/chat/<cid>/files/<fid>/done", methods=["POST"])
def chat_file_done(cid, fid):
    u = _me()
    _conv_or_404(cid, u)
    sender, size, chunks, ready = _file_or_404(cid, fid)
    if sender != u: abort(403)
    d = media_dir(fid)
    missing = [n for n in range(chunks) if not (d / f"{n}.bin").is_file() or (d / f"{n}.bin").stat().st_size != chunk_len(size, chunks, n)]
    if missing: return jsonify({"error": "Some of the attachment didn't arrive.", "missing": missing[:100]}), 409
    with _db_lock: db().execute("UPDATE files SET ready = 1 WHERE id = ?", (fid,))
    return jsonify({"ok": True})

# --- Disappearing messages ---
TTL_CHOICES = (0, 3600, 86400, 7 * 86400, 28 * 86400)

@app.route("/api/chat/<cid>/ttl", methods=["POST"])
def chat_ttl(cid):
    """Messages sent after this disappear, for everyone, once they're this old. Anyone in the chat can change it."""
    u = _me()
    ttl = _json().get("ttl")
    if ttl not in TTL_CHOICES: return jsonify({"error": "Pick one of the offered times."}), 400
    with SOCIAL_LOCK:
        c = _conv_or_404(cid, u)
        if int(c.get("ttl") or 0) != ttl:
            c["ttl"] = ttl
            c["ttl_log"] = (c.get("ttl_log") or [])[-19:] + [{"ttl": ttl, "by": u, "ts": time.time()}]
            conv_save(c)
            bump(c["members"], "c")
    return jsonify(conv_views(u, {cid})[0])

def chat_expiry():
    """Remove disappearing messages (and their attachments) as they expire, and uploads nobody finished."""
    while True:
        time.sleep(30)
        try:
            now = time.time()
            with _db_lock:
                gone = db().execute("SELECT id, conv FROM messages WHERE expires IS NOT NULL AND expires <= ?", (now,)).fetchall()
                if gone: db().execute("DELETE FROM messages WHERE expires IS NOT NULL AND expires <= ?", (now,))
            for mid, _ in gone: media_drop("msg = ?", (mid,))
            if gone:
                convs = {cv for _, cv in gone}
                for cv in convs:
                    c = conv_load(cv)
                    if c: bump(c["members"], "c")
            media_drop("msg IS NULL AND ts < ?", (now - 86400,))
        except Exception as ex:
            print(f"[ERROR] Disappearing messages cleanup failed: {ex}")

def media_stats():
    with _db_lock: n, size = db().execute("SELECT COUNT(*), COALESCE(SUM(size), 0) FROM files WHERE ready = 1").fetchone()
    return {"media_files": n, "media_bytes": size, "chat_dir": str(CHAT_DIR)}

@app.route("/api/chat/<cid>/read", methods=["POST"])
def chat_read(cid):
    u = _me()
    c = _conv_or_404(cid, u)
    seq = _json().get("seq")
    if not isinstance(seq, int): return jsonify({"error": "Bad position."}), 400
    with _db_lock:
        cur = db().execute("UPDATE conv_members SET read_seq = ? WHERE conv = ? AND user = ? AND read_seq < ?", (seq, cid, u, seq))
    if cur.rowcount: bump(c["members"], "c")
    return jsonify({"ok": True})

@app.route("/api/chat/<cid>/hide", methods=["POST"])
def chat_hide(cid):
    """Clear a chat for this listener only: earlier messages disappear from their list and devices."""
    u = _me()
    _conv_or_404(cid, u)
    with _db_lock:
        top = db().execute("SELECT COALESCE(MAX(seq), 0) FROM messages WHERE conv = ?", (cid,)).fetchone()[0]
        db().execute("UPDATE conv_members SET hidden_seq = ?, read_seq = MAX(read_seq, ?) WHERE conv = ? AND user = ?", (top, top, cid, u))
    bump(u, "c")
    return jsonify({"ok": True})

# --- Account removal, retention and admin numbers ---
def social_forget(u):
    """Remove an account from friends lists, playlists and conversations (called before the account is deleted)."""
    touched = set()
    with users_lock:
        for name, rec in users_data.items():
            if name == u: continue
            s = social_rec(rec)
            if any(u in s[k] for k in ("friends", "in", "out", "blocked")):
                for k in ("friends", "in", "out", "blocked"): _drop(s[k], u)
                touched.add(name)
    with SOCIAL_LOCK:
        for pl in _pl_rows():
            if pl["owner"] == u:
                if pl["collaborators"]:
                    pl["owner"] = pl["collaborators"].pop(0); pl_save(pl); touched.update(pl_members(pl))
                else: pl_delete(pl["id"])
            elif u in pl["collaborators"]:
                _drop(pl["collaborators"], u); pl_save(pl); touched.update(pl_members(pl))
        with _db_lock: cids = [r[0] for r in db().execute("SELECT conv FROM conv_members WHERE user = ?", (u,))]
        for cid in cids:
            c = conv_load(cid)
            if not c: continue
            if c["kind"] == "group" and u in c["members"]:
                c["members"].remove(u)
                c["events"].append({"t": "gone", "user": u, "n": len(c["events"]), "by": None, "ts": int(time.time() * 1000)})
            else:
                c["gone"] = sorted(set(c.get("gone") or []) | {u})
            conv_save(c)
            touched.update(c["members"])
    for k in [k for k, v in _links.items() if v["user"] == u]: _links.pop(k, None)
    _presence.pop(u, None)
    with _db_lock:
        db().execute("DELETE FROM plays WHERE user = ?", (u,))
        db().execute("DELETE FROM daily WHERE user = ?", (u,))
        db().execute("DELETE FROM events WHERE user = ?", (u,))
    bump(touched, "f", "c", "p")

def social_janitor():
    while True:
        time.sleep(3600)
        try:
            _purge_links()
            days = int(cfg().get("chat_retention_days") or 0)
            if days > 0:
                with _db_lock: n = db().execute("DELETE FROM messages WHERE ts < ?", (time.time() - days * 86400,)).rowcount
                if n: print(f"[INFO] Deleted {n} messages older than {days} days")
                media_drop("ts < ?", (time.time() - days * 86400,))
        except Exception as ex:
            print(f"[ERROR] Social cleanup failed: {ex}")

def social_stats():
    with users_lock:
        friendships = sum(len(social_rec(r)["friends"]) for r in users_data.values()) // 2
        keys = sum(1 for r in users_data.values() if r.get("e2ee"))
    with _db_lock:
        conn = db()
        convs = conn.execute("SELECT COUNT(*) FROM conversations").fetchone()[0]
        msgs = conn.execute("SELECT COUNT(*), COALESCE(SUM(LENGTH(data)), 0) FROM messages").fetchone()
        pls = conn.execute("SELECT COUNT(*) FROM shared_playlists").fetchone()[0]
    return dict({"friendships": friendships, "messaging": keys, "conversations": convs, "messages": msgs[0], "message_bytes": msgs[1], "collab_playlists": pls},
                **media_stats())

# ============================================================
# LIBRARY SHARING BETWEEN SERVERS
# ============================================================
# An admin shares this server's library by making a share key and giving it, with this server's address, to
# another server's admin. That server connects with the key, and its listeners see the shared music in their
# library (paths start with "@<connection id>/"). It fetches songs and artwork from here on their behalf, so this
# server only ever talks to that server, never to its listeners. Either side can stop at any time: revoking the key
# here, or removing the connection there. Sharing the other way is an offer the other admin accepts.
# Only this server's own music is shared, never music other servers share with it.
FED_FILE = CONFIG_DIR / "federation.json"
FED_DIR = CONFIG_DIR / "federation"
FED_REMOTE_RE = re.compile(r"^@(r[0-9a-z]{6})/(.+)$", re.S)
_fed_lock = threading.RLock()
_fed = {"state": None}
_fed_libs = {}           # connection id -> the shared library as last fetched
_fed_nocover = {}        # remote path -> when it last had no artwork
_fed_kick = threading.Event()

def fed_state():
    with _fed_lock:
        if _fed["state"] is None:
            st = _load_json_file(FED_FILE, {})
            st = st if isinstance(st, dict) else {}
            for k in ("shares", "remotes", "offers"): st.setdefault(k, [])
            _fed["state"] = st
        return _fed["state"]

def fed_save():
    with _fed_lock:
        tmp = FED_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(_fed["state"], indent=1))
        os.chmod(tmp, 0o600)   # holds the keys other servers gave this one
        os.replace(tmp, FED_FILE)

def fed_on(): return cfg().get("federation_enabled", True)

def fed_self_url():
    return (cfg().get("public_url") or fed_state().get("self_url") or "").rstrip("/")

def fed_norm_url(url):
    url = str(url or "").strip().rstrip("/")
    if url and not re.match(r"https?://", url, re.I): url = "https://" + url
    p = urllib.parse.urlparse(url)
    if p.scheme not in ("http", "https") or not p.netloc: return ""
    return f"{p.scheme}://{p.netloc}{p.path.rstrip('/')}"

def fed_remote(rid):
    with _fed_lock: return next((r for r in fed_state()["remotes"] if r["id"] == rid), None)

def remote_of(rel):
    """(connection, path on the other server) for a shared song's path, or (None, None)."""
    m = FED_REMOTE_RE.match(rel or "")
    return (fed_remote(m.group(1)), m.group(2)) if m else (None, None)

def fed_library_entries():
    """Shared music from other servers as (path, entry) pairs for the library index."""
    out = []
    with _fed_lock:
        remotes = [dict(r) for r in fed_state()["remotes"] if r.get("enabled", True) and r.get("status") != "revoked"] if fed_on() else []
    for r in remotes:
        lib = _fed_libs.get(r["id"])
        if lib is None:
            lib = _load_json_file(FED_DIR / f"{r['id']}.json", {}) or {}
            _fed_libs[r["id"]] = lib
        for rel, item in (lib.get("tracks") or {}).items():
            if isinstance(item, dict) and isinstance(rel, str) and not rel.startswith("@"):
                out.append((f"@{r['id']}/{rel}", dict(item, src=r["id"], src_name=r.get("name") or "")))
    return out

def fed_entry(rel):
    """The library entry for a song another server shares, or None."""
    rem, orig = remote_of(rel)
    if not rem: return None
    lib = _fed_libs.get(rem["id"])
    if lib is None:
        lib = _load_json_file(FED_DIR / f"{rem['id']}.json", {}) or {}
        _fed_libs[rem["id"]] = lib
    e = (lib.get("tracks") or {}).get(orig)
    return e if isinstance(e, dict) else None

def library_entry(rel):
    with library_cache_lock: e = library_cache_data.get(rel)
    return e if isinstance(e, dict) else fed_entry(rel)

# --- This server sharing its library ---
def fed_share_from_request():
    auth = request.headers.get("Authorization", "")
    key = auth[7:].strip() if auth.startswith("Bearer ") else ""
    if not key or not fed_on(): return None
    h = token_hash(key)
    with _fed_lock:
        s = next((x for x in fed_state()["shares"] if hmac.compare_digest(x["hash"], h)), None)
        if s:
            name, url = str(request.headers.get("X-Axdio-Name") or "")[:80], fed_norm_url(request.headers.get("X-Axdio-Url"))
            now = time.time()
            changed = (name and name != s.get("peer_name")) or (url and url != s.get("peer_url")) or now - s.get("last_seen", 0) > 900
            s["last_seen"] = now
            if name: s["peer_name"] = name
            if url: s["peer_url"] = url
            if changed: fed_save()
    return s

def _fed_guard():
    s = fed_share_from_request()
    if not s: abort(Response(json.dumps({"error": "This share key isn't valid. It may have been revoked."}), 401, mimetype="application/json"))
    return s

def fed_local_version():
    with library_cache_lock:
        return f"{len(library_cache_data)}:{int(max((e.get('mtime') or 0 for e in library_cache_data.values() if isinstance(e, dict)), default=0))}"

@app.route("/api/federation/hello")
def fed_hello():
    _fed_guard()
    with library_cache_lock: n = len(library_cache_data)
    return jsonify({"app": "Axdio", "app_version": AXDIO_VERSION, "name": str(cfg().get("site_title") or "Axdio"), "version": fed_local_version(), "tracks": n})

@app.route("/api/federation/library")
def fed_library():
    _fed_guard()
    keys = ("title", "artist", "album", "album_artist", "track_number", "has_cover", "duration", "mtime")
    with library_cache_lock:
        tracks = {rel: {k: e[k] for k in keys if e.get(k) not in (None, "")} for rel, e in library_cache_data.items() if isinstance(e, dict)}
    return jsonify({"name": str(cfg().get("site_title") or "Axdio"), "version": fed_local_version(), "tracks": tracks})

@app.route("/api/federation/stream")
def fed_stream():
    s = _fed_guard()
    rel = request.args.get("path") or ""
    fp = resolve_safe_music_file(rel) if rel and not rel.startswith("@") else None
    if not fp or not fp.exists(): abort(404)
    with listeners_lock:
        listeners["shared:" + s["id"]] = {"ip": client_ip(), "ua": f"Shared library · {s.get('peer_name') or s.get('label') or 'another server'}",
                                          "last_seen": time.time(), "path": Path(rel).name, "status": "STREAMING", "is_playing": True}
    return stream_file_response(fp, rel, QUALITY_KBPS.get(request.args.get("q", "")))

@app.route("/api/federation/cover")
def fed_cover():
    _fed_guard()
    rel = request.args.get("path") or ""
    f = cover_file_for(rel) if rel and not rel.startswith("@") else None
    if not f: abort(404)
    return send_file(f, mimetype="image/jpeg", max_age=86400)

@app.route("/api/federation/offer", methods=["POST"])
def fed_offer():
    """A server this one shares with offers to share its library back. The admin here accepts or declines."""
    s = _fed_guard()
    d = _json()
    url, key, name = fed_norm_url(d.get("url")), str(d.get("key") or ""), str(d.get("name") or "")[:80] or "Another server"
    if not url or not re.fullmatch(r"axs_[0-9A-Za-z_-]{30,60}", key): return jsonify({"error": "That offer is missing its address or key."}), 400
    with _fed_lock:
        st = fed_state()
        if any(r["url"] == url for r in st["remotes"]): return jsonify({"ok": True, "already": True})
        st["offers"] = [o for o in st["offers"] if o["url"] != url][-19:] + [{"id": "o" + secrets.token_hex(4), "name": name, "url": url, "key": key, "created": time.time(), "via": s["id"]}]
        fed_save()
    activity("federation", f"{name} offered to share its library with this server", None)
    notify("federation", "Library offered", f"**{name}** ({url}) offered to share its library. Accept it under Library sharing in the admin panel.")
    return jsonify({"ok": True})

@app.route("/api/federation/goodbye", methods=["POST"])
def fed_goodbye():
    """The other server removed its connection: its key is no longer needed."""
    s = _fed_guard()
    with _fed_lock:
        fed_state()["shares"] = [x for x in fed_state()["shares"] if x["id"] != s["id"]]
        fed_save()
    activity("federation", f"{s.get('peer_name') or s.get('label') or 'A server'} stopped using this server's shared library", None)
    return jsonify({"ok": True})

# --- Libraries other servers share with this one ---
def fed_headers(rem, extra=None):
    h = {"Authorization": "Bearer " + rem["key"], "X-Axdio-Name": str(cfg().get("site_title") or "Axdio")[:80],
         "User-Agent": f"Axdio/{AXDIO_VERSION}", "Accept-Encoding": "gzip"}
    if fed_self_url(): h["X-Axdio-Url"] = fed_self_url()
    h.update(extra or {})
    return h

def fed_call(rem, path, data=None, timeout=20):
    """JSON from another server's /api/federation endpoint, with "_status" set on errors (0 when unreachable)."""
    body = json.dumps(data).encode() if data is not None else None
    headers = fed_headers(rem, {"Content-Type": "application/json"} if body else None)
    req = urllib.request.Request(rem["url"] + path, data=body, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            if r.headers.get("Content-Encoding") == "gzip": raw = gzip.decompress(raw)
            return json.loads(raw.decode() or "{}")
    except urllib.error.HTTPError as ex:
        try: return json.loads(ex.read().decode() or "{}") | {"_status": ex.code}
        except Exception: return {"_status": ex.code}
    except Exception as ex:
        return {"_status": 0, "error": str(getattr(ex, "reason", ex))[:200]}

def _fed_set(rid, **kw):
    with _fed_lock:
        r = fed_remote(rid)
        if r: r.update(kw); fed_save()
        return r

def fed_forget_library(rid):
    _fed_libs.pop(rid, None)
    (FED_DIR / f"{rid}.json").unlink(missing_ok=True)

def fed_sync(rid, force=False):
    """Refresh one shared library. Returns the connection."""
    rem = fed_remote(rid)
    if not rem or rem.get("status") == "revoked": return rem
    hello = fed_call(rem, "/api/federation/hello")
    st = hello.get("_status")
    if st == 401:
        fed_forget_library(rid)
        rem = _fed_set(rid, status="revoked", error="They stopped sharing their library with this server.")
        activity("federation", f"{rem.get('name')} stopped sharing its library with this server", None, "warn")
        rebuild_in_memory_tree()
        return rem
    if st is not None or hello.get("app") != "Axdio":
        return _fed_set(rid, status="error", error=hello.get("error") or f"The server answered with an error ({st}).", checked=time.time())
    changed = False
    have = (FED_DIR / f"{rid}.json").exists()
    if force or not have or hello.get("version") != rem.get("version"):
        lib = fed_call(rem, "/api/federation/library", timeout=180)
        if lib.get("_status") is not None or not isinstance(lib.get("tracks"), dict):
            return _fed_set(rid, status="error", error=lib.get("error") or "Couldn't download the library.", checked=time.time())
        FED_DIR.mkdir(parents=True, exist_ok=True)
        tmp = FED_DIR / f"{rid}.tmp"
        tmp.write_text(json.dumps({"name": lib.get("name"), "version": lib.get("version"), "tracks": lib["tracks"]}))
        os.replace(tmp, FED_DIR / f"{rid}.json")
        _fed_libs[rid] = {"name": lib.get("name"), "version": lib.get("version"), "tracks": lib["tracks"]}
        changed = True
    rem = _fed_set(rid, status="ok", error="", name=str(hello.get("name") or rem.get("name"))[:80], tracks=hello.get("tracks", 0),
                   version=hello.get("version"), synced=time.time(), checked=time.time())
    if changed: rebuild_in_memory_tree()
    return rem

def fed_sync_loop():
    time.sleep(90)
    while True:
        try:
            if fed_on():
                with _fed_lock: ids = [r["id"] for r in fed_state()["remotes"] if r.get("enabled", True) and r.get("status") != "revoked"]
                for rid in ids: fed_sync(rid)
        except Exception as ex:
            print(f"[ERROR] Library sharing sync failed: {ex}")
        _fed_kick.wait(max(10, int(cfg().get("federation_sync_minutes") or 60)) * 60)
        _fed_kick.clear()

def fed_connect(url, key, share_back=False):
    """Connect to a library another server shares. Returns (connection, message) or raises ValueError."""
    url = fed_norm_url(url)
    key = str(key or "").strip()
    if not url: raise ValueError("Enter the other server's address, like https://music.example.com.")
    if not re.fullmatch(r"axs_[0-9A-Za-z_-]{30,60}", key): raise ValueError("That share key doesn't look right. It starts with axs_.")
    hello = fed_call({"url": url, "key": key}, "/api/federation/hello")
    if hello.get("_status") == 401: raise ValueError("That share key isn't valid, or it was revoked.")
    if hello.get("_status") == 0: raise ValueError(f"Couldn't reach {url}: {hello.get('error') or 'no answer'}.")
    if hello.get("_status") or hello.get("app") != "Axdio": raise ValueError("That address doesn't look like an Axdio server with library sharing.")
    with _fed_lock:
        st = fed_state()
        rem = next((r for r in st["remotes"] if r["url"] == url), None)
        if rem: rem.update(key=key, status="new", error="", enabled=True)
        else:
            rid = "r" + "".join(secrets.choice("0123456789abcdefghijklmnopqrstuvwxyz") for _ in range(6))
            rem = {"id": rid, "name": str(hello.get("name") or url)[:80], "url": url, "key": key, "added": time.time(), "enabled": True, "status": "new", "tracks": hello.get("tracks", 0)}
            st["remotes"].append(rem)
        st["offers"] = [o for o in st["offers"] if o["url"] != url]
        fed_save()
    threading.Thread(target=fed_sync, args=(rem["id"], True), daemon=True).start()
    msg = ""
    if share_back:
        if not fed_self_url(): msg = "Set this server's public address under General first to share back."
        else:
            key2, share = fed_new_share(f"{rem['name']} (shared back)")
            r = fed_call(rem, "/api/federation/offer", {"name": str(cfg().get("site_title") or "Axdio"), "url": fed_self_url(), "key": key2})
            if r.get("_status") is not None:
                with _fed_lock:
                    fed_state()["shares"] = [x for x in fed_state()["shares"] if x["id"] != share["id"]]
                    fed_save()
                msg = f"Connected, but offering your library back failed: {r.get('error') or r.get('_status')}."
            else:
                msg = "They'll see an offer to add your library too."
                with _fed_lock:
                    rem["shared_back"] = share["id"]
                    fed_save()
    return rem, msg

def fed_new_share(label):
    key = "axs_" + secrets.token_urlsafe(32)
    share = {"id": "s" + secrets.token_hex(4), "label": str(label or "")[:80] or "Another server", "hash": token_hash(key), "created": time.time(), "last_seen": 0}
    with _fed_lock:
        fed_state()["shares"].append(share)
        fed_save()
    return key, share

def fed_code(url, key):
    """One string to hand over: the address and key together."""
    return "axdio-share:" + base64.urlsafe_b64encode(json.dumps({"u": url, "k": key}, separators=(",", ":")).encode()).decode().rstrip("=")

def fed_parse_code(code):
    try:
        raw = str(code or "").strip().split("axdio-share:", 1)[1]
        d = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)).decode())
        return d.get("u"), d.get("k")
    except Exception:
        return None, None

def remote_stream(rel, kbps=None):
    """Play a song from a library another server shares: fetched from there and passed through (seeking included)."""
    rem, orig = remote_of(rel)
    if not rem or not rem.get("enabled", True) or rem.get("status") == "revoked" or not fed_on(): abort(404)
    q = {"path": orig}
    if kbps: q["q"] = next((k for k, v in QUALITY_KBPS.items() if v == kbps), "")
    extra = {"Accept-Encoding": "identity"}
    if request.headers.get("Range"): extra["Range"] = request.headers["Range"]
    req = urllib.request.Request(rem["url"] + "/api/federation/stream?" + urllib.parse.urlencode(q), headers=fed_headers(rem, extra))
    try:
        r = urllib.request.urlopen(req, timeout=25)
    except urllib.error.HTTPError as ex:
        if ex.code == 401: threading.Thread(target=fed_sync, args=(rem["id"],), daemon=True).start()
        return Response(status=ex.code if ex.code in (404, 416) else 502)
    except Exception:
        return jsonify({"error": f"{rem.get('name') or 'The other server'} isn't reachable right now."}), 502
    def chunks():
        try:
            while True:
                b = r.read(64 * 1024)
                if not b: break
                yield b
        finally:
            r.close()
    resp = Response(chunks(), status=r.status, mimetype=r.headers.get("Content-Type") or "application/octet-stream", direct_passthrough=True)
    for h in ("Content-Length", "Content-Range", "Accept-Ranges"):
        if r.headers.get(h): resp.headers[h] = r.headers[h]
    return resp

def remote_cover(rel):
    """Artwork for a shared song, fetched once and kept with the local covers."""
    cache = COVERS_CACHE_DIR / f"{hashlib.md5(rel.encode()).hexdigest()}.jpg"
    if cache.exists(): return send_file(cache, mimetype="image/jpeg", max_age=2592000)
    rem, orig = remote_of(rel)
    if rem and fed_on() and time.time() - _fed_nocover.get(rel, 0) > 3600:
        req = urllib.request.Request(rem["url"] + "/api/federation/cover?" + urllib.parse.urlencode({"path": orig}), headers=fed_headers(rem, {"Accept-Encoding": "identity"}))
        try:
            with urllib.request.urlopen(req, timeout=15) as r: data = r.read(8 * 1024 * 1024)
        except Exception: data = b""
        if data[:3] == b"\xff\xd8\xff" or data[:8] == b"\x89PNG\r\n\x1a\n":
            try:
                cache.write_bytes(data)
                return send_file(cache, mimetype="image/jpeg", max_age=2592000)
            except OSError:
                return Response(data, mimetype="image/png" if data[:4] == b"\x89PNG" else "image/jpeg")
        _fed_nocover[rel] = time.time()
    return Response(DEFAULT_SVG_COVER, mimetype="image/svg+xml")

# --- Admin: library sharing ---
def fed_view():
    with _fed_lock:
        st = fed_state()
        return {"enabled": fed_on(), "self_url": fed_self_url(), "public_url_set": bool(cfg().get("public_url")),
                "shares": [{k: s.get(k) for k in ("id", "label", "created", "last_seen", "peer_name", "peer_url")} for s in st["shares"]],
                "remotes": [{k: r.get(k) for k in ("id", "name", "url", "added", "enabled", "status", "error", "synced", "checked", "tracks", "shared_back")} for r in st["remotes"]],
                "offers": [{k: o.get(k) for k in ("id", "name", "url", "created")} for o in st["offers"]]}

@app.route("/api/admin/v2/federation")
def av2_federation():
    with _fed_lock:
        st = fed_state()
        if not cfg().get("public_url") and st.get("self_url") != base_url():
            st["self_url"] = base_url()   # used when talking to other servers from background threads
            fed_save()
    return jsonify(fed_view())

@app.route("/api/admin/v2/federation/shares", methods=["POST"])
def av2_federation_share():
    label = str(_json().get("label") or "").strip()[:80]
    if not label: return jsonify({"error": "Say who the key is for."}), 400
    key, share = fed_new_share(label)
    activity("federation", f"Made a share key for {label}", admin_name())
    url = fed_self_url() or base_url()
    return jsonify({"key": key, "url": url, "code": fed_code(url, key), "share": {k: share[k] for k in ("id", "label", "created")}, "view": fed_view()})

@app.route("/api/admin/v2/federation/shares/<sid>", methods=["DELETE"])
def av2_federation_unshare(sid):
    with _fed_lock:
        s = next((x for x in fed_state()["shares"] if x["id"] == sid), None)
        if not s: return jsonify({"error": "That key isn't there anymore."}), 404
        fed_state()["shares"] = [x for x in fed_state()["shares"] if x["id"] != sid]
        fed_save()
    activity("federation", f"Stopped sharing the library with {s.get('peer_name') or s['label']}", admin_name(), "warn")
    return jsonify(fed_view())

@app.route("/api/admin/v2/federation/remotes", methods=["POST"])
def av2_federation_connect():
    d = _json()
    url, key = (fed_parse_code(d["code"]) if d.get("code") else (d.get("url"), d.get("key")))
    try: rem, msg = fed_connect(url, key, bool(d.get("share_back")))
    except ValueError as ex: return jsonify({"error": str(ex)}), 400
    activity("federation", f"Connected to the library {rem['name']} shares", admin_name())
    return jsonify({"ok": True, "message": msg, "view": fed_view()})

@app.route("/api/admin/v2/federation/remotes/<rid>", methods=["POST", "DELETE"])
def av2_federation_remote(rid):
    rem = fed_remote(rid)
    if not rem: return jsonify({"error": "That connection isn't there anymore."}), 404
    if request.method == "DELETE":
        if rem.get("status") != "revoked": fed_call(rem, "/api/federation/goodbye", {}, timeout=8)
        with _fed_lock:
            fed_state()["remotes"] = [r for r in fed_state()["remotes"] if r["id"] != rid]
            fed_save()
        fed_forget_library(rid)
        rebuild_in_memory_tree()
        activity("federation", f"Removed the library shared by {rem.get('name')}", admin_name())
        return jsonify(fed_view())
    d = _json()
    if "enabled" in d:
        _fed_set(rid, enabled=bool(d["enabled"]))
        rebuild_in_memory_tree()
    if d.get("sync"): fed_sync(rid, force=True)
    return jsonify(fed_view())

@app.route("/api/admin/v2/federation/offers/<oid>/<action>", methods=["POST"])
def av2_federation_offer(oid, action):
    with _fed_lock:
        o = next((x for x in fed_state()["offers"] if x["id"] == oid), None)
        if not o: return jsonify({"error": "That offer isn't there anymore."}), 404
        fed_state()["offers"] = [x for x in fed_state()["offers"] if x["id"] != oid]
        fed_save()
    if action == "accept":
        try: fed_connect(o["url"], o["key"])
        except ValueError as ex: return jsonify({"error": str(ex)}), 400
        activity("federation", f"Accepted the library {o['name']} shares", admin_name())
    return jsonify(fed_view())


# ============================================================
# DISCORD: sign-in and "Listening to" status
# ============================================================
# Sign-in uses Discord OAuth2 (scope "identify"): an admin creates a Discord application and enters its ID and
# secret. Accounts are matched by Discord user id; new accounts follow the server's sign-up mode. The app gets its
# login token by trading a one-time code, so no token ever appears in a URL.
#
# Rich presence: Discord only lets programs on the listener's own computer set their status, through the Discord
# app's local connection. Listeners download a small helper script (made for them, with a key only it uses) that
# reads what they're playing from GET /api/presence and passes it to Discord.
DISCORD_API = "https://discord.com/api/v10"
_login_codes = {}

def discord_login_ready():
    c = cfg()
    return bool(c.get("discord_login") and re.fullmatch(r"\d{15,22}", str(c.get("discord_client_id") or "")) and c.get("discord_client_secret"))

def discord_presence_ready():
    c = cfg()
    return bool(c.get("discord_presence", True) and re.fullmatch(r"\d{15,22}", str(c.get("discord_client_id") or "")))

ORIGIN_RE = re.compile(r"https?://[A-Za-z0-9.-]+(:\d{1,5})?")

def page_origin(value):
    """An address a page says it was opened at, if it looks like one. Behind a proxy that doesn't pass on the
    host, this is the only way to know the address people use (short of a Public URL)."""
    value = str(value or "").strip().rstrip("/")
    return value if ORIGIN_RE.fullmatch(value) else ""

def discord_redirect(origin=""):
    # The page's own address first: the sign-in comes back to the same address (and its cookies). Discord only
    # accepts redirects registered for the application, so a made-up address gets nowhere.
    return (page_origin(origin) or (cfg().get("public_url") or "").rstrip("/") or base_url()) + "/auth/discord/callback"

def login_code(username):
    now = time.time()
    for k in [k for k, v in _login_codes.items() if now - v[1] > 120]: _login_codes.pop(k, None)
    code = secrets.token_urlsafe(24)
    _login_codes[code] = (username, now)
    return code

def _session_login_response(u):
    with users_lock:
        rec = users_data.get(u)
        if not rec: return jsonify({"error": "That account no longer exists."}), 404
        if rec.get("disabled"): return jsonify({"error": "This account has been disabled. Contact the server admin."}), 403
        token = issue_token(rec)
        rec["last_login"] = datetime.now().isoformat()
        save_users(u)
        _start_user_session(u)
        return jsonify({"success": True, "username": u, "display_name": rec.get("display_name", u), "avatar": rec.get("avatar", ""),
                        "token": token, "is_admin": bool(rec.get("is_admin"))})

@app.route("/api/auth/exchange", methods=["POST"])
def auth_exchange():
    entry = _login_codes.pop(str(_json().get("code") or ""), None)
    if not entry or time.time() - entry[1] > 120: return jsonify({"error": "That sign-in link expired. Try again."}), 400
    login_succeeded(client_ip())
    return _session_login_response(entry[0])

def discord_username(ident):
    base = re.sub(r"[^a-z0-9_.-]", "", str(ident.get("username") or "").lower()).strip("._-")[:28] or "listener"
    if len(base) < 2: base += "01"
    name, i = base, 2
    while name in users_data or not USERNAME_RE.match(name):
        name = f"{base[:28]}{i}"; i += 1
    return name

def _discord_avatar(u, ident):
    try:
        data = fetch_bytes(f"https://cdn.discordapp.com/avatars/{ident['id']}/{ident['avatar']}.png?size=512", limit=4 * 1024 * 1024)
        if not data: return
        url = save_avatar(data)
        with users_lock:
            rec = users_data.get(u)
            if rec is not None and not rec.get("avatar"):
                rec["avatar"] = url
                save_users(u)
            else: avatar_file(url).unlink(missing_ok=True)
    except Exception as ex: print(f"[WARN] Couldn't copy a Discord avatar: {ex}")

def create_discord_account(ident, invite_code=None):
    with users_lock:
        u = discord_username(ident)
        rec = _new_user_record(secrets.token_urlsafe(32), str(ident.get("name") or u)[:32])
        rec["password_login"] = False   # signs in with Discord until they set a password
        rec["discord"] = {"id": ident["id"], "username": ident.get("username") or "", "name": ident.get("name") or "", "linked": time.time()}
        if invite_code: rec["invited_with"] = invite_code
        users_data[u] = rec
        save_users(u)
    if ident.get("avatar") and cfg().get("feature_avatars", True):
        threading.Thread(target=_discord_avatar, args=(u, ident), daemon=True).start()
    c = cfg()
    activity("register", "New account with Discord" + (f" and invite {invite_code}" if invite_code else ""), u)
    notify("user_registered", "New account", f"**{rec['display_name']}** (`{u}`) signed up with Discord on {c.get('site_title', 'Axdio')}.")
    return u

@app.route("/auth/discord")
def discord_start():
    link = request.args.get("link") == "1"
    if not discord_login_ready(): return redirect("/settings?discord=unavailable" if link else "/?discord=unavailable")
    if link and not get_current_user(): return redirect("/?discord=error")
    state = secrets.token_urlsafe(24)
    back = discord_redirect(request.args.get("o"))
    session["discord_oauth"] = {"state": state, "mode": "link" if link else "login", "t": time.time(), "redirect": back}
    return redirect("https://discord.com/oauth2/authorize?" + urllib.parse.urlencode({
        "client_id": cfg()["discord_client_id"], "redirect_uri": back, "response_type": "code", "scope": "identify",
        "state": state, "prompt": "none"}))

def discord_identity(code, redirect_uri=None):
    c = cfg()
    try:
        tok = _http_json(DISCORD_API + "/oauth2/token", {"client_id": c["discord_client_id"], "client_secret": c["discord_client_secret"],
                                                         "grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri or discord_redirect()},
                         {"Content-Type": "application/x-www-form-urlencoded"})
        if not tok or not tok.get("access_token"): return None
        me = _http_json(DISCORD_API + "/users/@me", headers={"Authorization": "Bearer " + tok["access_token"]})
    except Exception as ex:
        print(f"[WARN] Discord sign-in failed: {ex}")
        return None
    if not me or not re.fullmatch(r"\d{15,22}", str(me.get("id") or "")): return None
    return {"id": str(me["id"]), "username": str(me.get("username") or "")[:40], "name": str(me.get("global_name") or me.get("username") or "")[:40],
            "avatar": str(me.get("avatar") or "") if re.fullmatch(r"(a_)?[0-9a-f]{32}", str(me.get("avatar") or "")) else ""}

@app.route("/api/admin/v2/discord")
def av2_discord():
    return jsonify({"public_url": (cfg().get("public_url") or "").rstrip("/"), "server_sees": base_url(),
                    "redirect_path": "/auth/discord/callback"})

@app.route("/auth/discord/callback")
def discord_callback():
    st = session.pop("discord_oauth", None) or {}
    back = "/settings" if st.get("mode") == "link" else "/"
    if not st or request.args.get("state") != st.get("state") or time.time() - st.get("t", 0) > 600: return redirect(back + "?discord=error")
    if request.args.get("error"): return redirect(back + "?discord=cancelled")
    if not discord_login_ready(): return redirect(back + "?discord=unavailable")
    ident = discord_identity(request.args.get("code", ""), st.get("redirect"))
    if not ident: return redirect(back + "?discord=error")
    with users_lock: owner = next((u for u, r in users_data.items() if (r.get("discord") or {}).get("id") == ident["id"]), None)
    if st["mode"] == "link":
        u = get_current_user()
        if not u: return redirect("/?discord=error")
        if owner and owner != u: return redirect("/settings?discord=taken")
        with users_lock:
            users_data[u]["discord"] = {"id": ident["id"], "username": ident["username"], "name": ident["name"], "linked": time.time()}
            save_users(u)
        activity("account", f"Connected Discord (@{ident['username']})", u)
        return redirect("/settings?discord=linked")
    if owner:
        if users_data[owner].get("disabled"): return redirect("/?discord=disabled")
        return redirect("/?login=" + login_code(owner))
    mode = cfg().get("registration", "open")
    if mode == "closed": return redirect("/?discord=no-account")
    if mode == "invite":
        session["discord_pending"] = dict(ident, t=time.time())
        return redirect("/?discord=invite")
    return redirect("/?login=" + login_code(create_discord_account(ident)) + "&discord=welcome")

@app.route("/api/auth/discord/finish", methods=["POST"])
def discord_finish():
    """Invite-only servers: a new Discord sign-in finishes with an invite code."""
    p = session.get("discord_pending")
    if not p or time.time() - p.get("t", 0) > 900: return jsonify({"error": "Start again with Discord."}), 400
    code = str(_json().get("invite_code") or "").strip().upper()
    with _invites_lock:
        invites = load_invites()
        inv = invites.get(code) if code else None
        if not inv or invite_state(inv) != "active": return jsonify({"error": "That invite code isn't valid."}), 403
        with users_lock: owner = next((u for u, r in users_data.items() if (r.get("discord") or {}).get("id") == p["id"]), None)
        u = owner or create_discord_account(p, code)
        if not owner:
            inv["uses"] = inv.get("uses", 0) + 1
            inv.setdefault("used_by", []).append(u)
            save_invites(invites)
    session.pop("discord_pending", None)
    return _session_login_response(u)

@app.route("/api/user/discord/unlink", methods=["POST"])
def discord_unlink():
    u = _me()
    with users_lock:
        rec = users_data[u]
        if rec.get("password_login") is False: return jsonify({"error": "Set a password first, so you can still sign in without Discord."}), 400
        rec.pop("discord", None)
        save_users(u)
    activity("account", "Disconnected Discord", u)
    return jsonify({"ok": True})

# --- "Listening to" on Discord ---
PRESENCE_HELPER = r'''#!/usr/bin/env python3
"""Shows what you're playing on __SITE__ as your Discord status ("Listening to ...").

Set up once on the computer where you use the Discord app: double-click this file (or run
"python3 axdio-discord.py", or "py axdio-discord.py" on Windows). It installs itself, starts
quietly in the background, and from then on starts by itself whenever you sign in to the computer.

It needs Python 3.8 or newer and nothing else. It reads what you're playing from your server and
hands it to the Discord app on this computer; nothing else leaves your computer.

    axdio-discord.py              set up (again) and start in the background
    axdio-discord.py --run        run in this window instead, to see what it's doing
    axdio-discord.py --stop       stop it until you next sign in
    axdio-discord.py --uninstall  stop it and remove it from this computer

Turning off Discord status in __SITE__'s Settings also removes it, the next time it checks in.
"""
SERVER = __SERVER__
KEY = __KEY__
SITE = __SITE_REPR__

import json, os, shutil, socket, struct, subprocess, sys, threading, time, urllib.error, urllib.request, uuid

PORT = 47823                      # on this computer only: keeps one copy running, and lets a new one replace it
TASK = "Axdio Discord status"     # its name in the list of programs that start when you sign in


def data_dir():
    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or os.path.expanduser("~")
    elif sys.platform == "darwin":
        base = os.path.expanduser("~/Library/Application Support")
    else:
        base = os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")
    return os.path.join(base, "Axdio")


HOME = data_dir()
INSTALLED = os.path.join(HOME, "axdio-discord.py")
LOGFILE = os.path.join(HOME, "axdio-discord.log")


def log(msg):
    try:
        print(time.strftime("%Y-%m-%d %H:%M:%S"), msg, flush=True)
    except Exception:
        pass


class Discord:
    """The Discord app's local connection (the one games and music players use)."""

    def __init__(self):
        self.sock = self.pipe = None
        self.app_id = None

    @staticmethod
    def paths():
        if sys.platform == "win32":
            return [r"\\?\pipe\discord-ipc-%d" % i for i in range(10)]
        roots = [os.environ.get(k) for k in ("XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP")]
        if sys.platform == "darwin":
            try:
                roots.append(os.confstr("CS_DARWIN_USER_TEMP_DIR"))   # when started at sign-in, TMPDIR may be unset
            except (ValueError, OSError, AttributeError):
                pass
        roots.append("/run/user/%d" % os.getuid() if hasattr(os, "getuid") else None)
        roots.append("/tmp")
        subs = ("", "app/com.discordapp.Discord", "app/com.discordapp.DiscordCanary", "snap.discord", "app/dev.vencord.Vesktop")
        seen, out = set(), []
        for r in roots:
            for s in subs:
                for i in range(10):
                    p = os.path.join(r, s, "discord-ipc-%d" % i) if r else None
                    if p and p not in seen:
                        seen.add(p)
                        out.append(p)
        return out

    def connect(self, app_id):
        self.close()
        for path in self.paths():
            try:
                if sys.platform == "win32":
                    self.pipe = open(path, "r+b", buffering=0)
                else:
                    if not os.path.exists(path):
                        continue
                    self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                    self.sock.settimeout(10)
                    self.sock.connect(path)
                self.send(0, {"v": 1, "client_id": str(app_id)})
                if self.recv()[1].get("evt") == "READY":
                    self.app_id = app_id
                    return True
            except (OSError, ValueError):
                pass
            self.close()
        return False

    def send(self, op, payload):
        data = json.dumps(payload).encode()
        frame = struct.pack("<II", op, len(data)) + data
        if self.pipe:
            self.pipe.write(frame)
        else:
            self.sock.sendall(frame)

    def _read(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.pipe.read(n - len(buf)) if self.pipe else self.sock.recv(n - len(buf))
            if not chunk:
                raise OSError("Discord closed the connection")
            buf += chunk
        return buf

    def recv(self):
        op, n = struct.unpack("<II", self._read(8))
        return op, json.loads(self._read(n).decode() or "{}")

    def set_activity(self, activity):
        self.send(1, {"cmd": "SET_ACTIVITY", "args": {"pid": os.getpid(), "activity": activity}, "nonce": str(uuid.uuid4())})
        while True:
            op, data = self.recv()
            if op == 3:
                self.send(4, data)
                continue
            if op == 2:
                raise OSError("Discord closed the connection")
            return data

    def close(self):
        for f in (self.sock, self.pipe):
            try:
                if f:
                    f.close()
            except OSError:
                pass
        self.sock = self.pipe = None
        self.app_id = None


def fetch():
    req = urllib.request.Request(SERVER + "/api/presence", headers={"Authorization": "Bearer " + KEY, "User-Agent": "Axdio-Discord/2"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())


# --- One copy at a time ---------------------------------------------------------------------------

def claim():
    """Hold a local port while running. Returns None if another copy already has it."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        if sys.platform == "win32":
            s.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        else:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(("127.0.0.1", PORT))
        s.listen(4)
    except OSError:
        s.close()
        return None

    def serve():
        while True:
            try:
                c, _ = s.accept()
            except OSError:
                return
            try:
                c.settimeout(5)
                if c.recv(32).startswith(b"axdio-stop"):
                    c.sendall(b"axdio-ok")
                    log("Stopped (another copy is taking over, or you asked it to stop).")
                    os._exit(0)
            except OSError:
                pass
            finally:
                c.close()
    threading.Thread(target=serve, daemon=True).start()
    return s


def stop_running():
    """Ask a running copy to stop. True if one was running."""
    try:
        with socket.create_connection(("127.0.0.1", PORT), timeout=3) as c:
            c.sendall(b"axdio-stop")
            c.settimeout(5)
            stopped = c.recv(16).startswith(b"axdio-ok")
    except OSError:
        return False
    for _ in range(50):   # wait for it to let go of the port
        try:
            socket.create_connection(("127.0.0.1", PORT), timeout=0.2).close()
            time.sleep(0.1)
        except OSError:
            break
    return stopped


# --- Starting at sign-in ----------------------------------------------------------------------------

def quiet_python():
    """On Windows, pythonw.exe runs without a window."""
    exe = sys.executable
    if sys.platform == "win32":
        w = os.path.join(os.path.dirname(exe), "pythonw.exe")
        if os.path.exists(w):
            return w
    return exe


def run_quietly(cmd):
    if sys.platform == "win32":
        flags = 0x00000008 | 0x00000200   # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
        subprocess.Popen(cmd, creationflags=flags, close_fds=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        subprocess.Popen(cmd, start_new_session=True, close_fds=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def mac_agent():
    return os.path.expanduser("~/Library/LaunchAgents/com.axdio.discord.plist")


def linux_unit():
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    return os.path.join(base, "systemd", "user", "axdio-discord.service"), os.path.join(base, "autostart", "axdio-discord.desktop")


def has_user_systemd():
    try:
        return subprocess.run(["systemctl", "--user", "show-environment"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def add_to_startup():
    """Start at sign-in, and start now. Returns a description of what it did."""
    cmd = [quiet_python(), INSTALLED, "--background"]
    if sys.platform == "win32":
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run", 0, winreg.KEY_SET_VALUE) as k:
            winreg.SetValueEx(k, TASK, 0, winreg.REG_SZ, subprocess.list2cmdline(cmd))
        run_quietly(cmd)
        return "It starts by itself when you sign in to Windows (it's listed as \"%s\" under Settings > Apps > Startup)." % TASK
    if sys.platform == "darwin":
        import plistlib
        path = mac_agent()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        subprocess.run(["launchctl", "unload", path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        with open(path, "wb") as f:
            plistlib.dump({"Label": "com.axdio.discord", "ProgramArguments": cmd, "RunAtLoad": True,
                           "KeepAlive": {"SuccessfulExit": False}, "ProcessType": "Background"}, f)
        subprocess.run(["launchctl", "load", "-w", path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return "It starts by itself when you log in to your Mac."
    unit, desktop = linux_unit()
    if has_user_systemd():
        os.makedirs(os.path.dirname(unit), exist_ok=True)
        with open(unit, "w") as f:
            f.write("[Unit]\nDescription=%s\nAfter=graphical-session.target\n\n[Service]\nExecStart=%s\nRestart=on-failure\nRestartSec=30\n\n"
                    "[Install]\nWantedBy=default.target\n" % (TASK, " ".join('"%s"' % c for c in cmd)))
        subprocess.run(["systemctl", "--user", "daemon-reload"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["systemctl", "--user", "enable", "--now", "axdio-discord.service"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["systemctl", "--user", "restart", "axdio-discord.service"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return "It starts by itself when you log in."
    os.makedirs(os.path.dirname(desktop), exist_ok=True)
    with open(desktop, "w") as f:
        f.write("[Desktop Entry]\nType=Application\nName=%s\nExec=%s\nNoDisplay=true\nX-GNOME-Autostart-enabled=true\n" % (TASK, " ".join('"%s"' % c for c in cmd)))
    run_quietly(cmd)
    return "It starts by itself when you log in."


def remove_from_startup():
    if sys.platform == "win32":
        import winreg
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run", 0, winreg.KEY_SET_VALUE) as k:
                winreg.DeleteValue(k, TASK)
        except OSError:
            pass
    elif sys.platform == "darwin":
        path = mac_agent()
        if os.path.exists(path):
            subprocess.run(["launchctl", "unload", "-w", path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            os.remove(path)
    else:
        unit, desktop = linux_unit()
        if os.path.exists(unit):
            subprocess.run(["systemctl", "--user", "disable", "axdio-discord.service"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            os.remove(unit)
            subprocess.run(["systemctl", "--user", "daemon-reload"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if os.path.exists(desktop):
            os.remove(desktop)


def installed_is_this_one():
    """The installed copy belongs to this setup (and not to a newer one that replaced it)."""
    try:
        with open(INSTALLED, encoding="utf-8") as f:
            return KEY in f.read()
    except OSError:
        return False


def uninstall(from_inside=False):
    if not from_inside:
        stop_running()
    remove_from_startup()
    for f in (INSTALLED, LOGFILE):
        try:
            os.remove(f)
        except OSError:
            pass


def install():
    print("Setting up Discord status for %s..." % SITE)
    if sys.version_info < (3, 8):
        print("This needs Python 3.8 or newer. Get it from https://www.python.org/downloads/")
        return 1
    os.makedirs(HOME, exist_ok=True)
    here = os.path.abspath(__file__)
    if os.path.normcase(here) != os.path.normcase(INSTALLED):
        shutil.copyfile(here, INSTALLED)
    if stop_running():
        print("Replaced the copy that was already running.")
    try:
        how = add_to_startup()
    except Exception as ex:
        print("Couldn't set it to start by itself (%s)." % ex)
        print("You can still run it in a window with: axdio-discord.py --run")
        return 1
    print()
    print("All set. It's running in the background and shows what you play on %s as your Discord status" % SITE)
    print("whenever the Discord app is open on this computer.")
    print(how)
    print()
    print("You can delete the file you downloaded; a copy is kept in " + HOME)
    print("To remove it later, turn off Discord status in %s's Settings, or run it with --uninstall." % SITE)
    return 0


# --- Showing the status -------------------------------------------------------------------------------

def run(background=False):
    if background:
        os.makedirs(HOME, exist_ok=True)
        try:
            if os.path.getsize(LOGFILE) > 512 * 1024:
                os.replace(LOGFILE, LOGFILE + ".old")
        except OSError:
            pass
        sys.stdout = sys.stderr = open(LOGFILE, "a", encoding="utf-8", buffering=1)
    lock = claim()
    if lock is None:
        log("It's already running in the background. To watch it in a window instead, run it with --run.")
        return 0
    discord, last, waiting, app_id, fetched = Discord(), None, False, None, 0
    log("Showing what you play on %s in Discord." % SERVER + ("" if background else " Leave this window open; Ctrl+C stops it."))
    while True:
        try:
            # With the Discord app closed there's nothing to show: look for it without asking the server each time.
            if app_id and discord.app_id != app_id and time.time() - fetched < 300:
                if not discord.connect(app_id):
                    time.sleep(15)
                    continue
                log("Connected to Discord.")
                waiting, last = False, None
            try:
                d = fetch()
                fetched = time.time()
            except urllib.error.HTTPError as ex:
                if ex.code == 401:
                    log("Discord status was turned off in Settings, or set up again. Stopping.")
                    discord.close()
                    if installed_is_this_one():
                        uninstall(from_inside=True)   # turned off: nothing is left behind
                    return 0
                log("The server answered %s. Trying again in a minute." % ex.code)
                time.sleep(60)
                continue
            except Exception as ex:
                log("Can't reach %s (%s). Trying again in 30 seconds." % (SERVER, getattr(ex, "reason", ex)))
                time.sleep(30)
                continue
            app_id, activity = d.get("app_id"), d.get("activity")
            if not app_id:
                log(d.get("message") or "Discord status is turned off on the server.")
                time.sleep(120)
                continue
            if discord.app_id != app_id:
                if not discord.connect(app_id):
                    if not waiting:
                        log("Waiting for the Discord app to be open on this computer...")
                        waiting = True
                    time.sleep(15)
                    continue
                log("Connected to Discord.")
                waiting, last = False, None
            key = json.dumps(activity, sort_keys=True)
            if key != last:
                res = discord.set_activity(activity)
                if activity and res.get("evt") == "ERROR":
                    # Older Discord versions don't know every field: fall back to the basics.
                    discord.set_activity({k: v for k, v in activity.items() if k not in ("type", "status_display_type", "buttons")})
                last = key
                log("Now showing: %s" % ("%s by %s" % (activity.get("details"), activity.get("state")) if activity else "nothing (paused)"))
            time.sleep(d.get("poll") or 5)
        except OSError as ex:
            log("Lost the connection to Discord (%s). Reconnecting..." % ex)
            discord.close()
            time.sleep(5)
        except Exception as ex:
            log("Something went wrong (%r). Trying again in 30 seconds." % ex)
            discord.close()
            time.sleep(30)


def main(args):
    if "--background" in args:
        return run(background=True)
    if "--run" in args:
        stop_running()
        return run()
    if "--stop" in args:
        print("Stopped." if stop_running() else "It wasn't running.")
        return 0
    if "--uninstall" in args:
        uninstall()
        print("Removed. It won't start again, and the copy in %s is gone." % HOME)
        return 0
    return install()


if __name__ == "__main__":
    code = 1
    try:
        code = main(sys.argv[1:])
    except KeyboardInterrupt:
        print()
        log("Stopped.")
        code = 0
    if "--background" not in sys.argv and sys.stdin is not None and sys.stdin.isatty():
        try:
            input("\nPress Enter to close this window.")
        except (EOFError, KeyboardInterrupt):
            pass
    sys.exit(code)
'''

def presence_helper(server, key):
    site = str(cfg().get("site_title") or "Axdio").replace('"', "'").replace("\\", "")[:60]
    return (PRESENCE_HELPER.replace("__SITE_REPR__", repr(site)).replace("__SITE__", site)
            .replace("__SERVER__", repr(server.rstrip("/"))).replace("__KEY__", repr(key)))

_presence_polls = {}   # username -> when their helper last asked

@app.route("/api/user/presence", methods=["GET", "POST", "DELETE"])
def user_presence():
    u = _me()
    if request.method == "POST":
        if not discord_presence_ready(): return jsonify({"error": "Discord status isn't set up on this server."}), 400
        key = "axp_" + secrets.token_urlsafe(24)
        with users_lock:
            users_data[u]["presence"] = {"hash": token_hash(key), "created": time.time()}
            save_users(u)
        activity("account", "Set up Discord status", u)
        server = (cfg().get("public_url") or "").rstrip("/") or page_origin(request.headers.get("Origin")) or base_url()
        return jsonify({"ok": True, "filename": "axdio-discord.py", "script": presence_helper(server, key)})
    if request.method == "DELETE":
        with users_lock:
            users_data[u].pop("presence", None)
            save_users(u)
        return jsonify({"ok": True})
    with users_lock: p = users_data[u].get("presence") or {}
    return jsonify({"available": discord_presence_ready(), "enabled": bool(p), "created": p.get("created"), "seen": _presence_polls.get(u, 0)})

@app.route("/api/presence")
def presence_feed():
    """What the listener is playing, shaped as a Discord activity, for their helper."""
    auth = request.headers.get("Authorization", "")
    key = auth[7:].strip() if auth.startswith("Bearer ") else ""
    h = token_hash(key) if key else ""
    with users_lock:
        u = next((n for n, r in users_data.items() if h and hmac.compare_digest((r.get("presence") or {}).get("hash", ""), h)), None) if h else None
        if u and users_data[u].get("disabled"): u = None
    if not u: return jsonify({"error": "This helper was turned off."}), 401
    _presence_polls[u] = time.time()
    c = cfg()
    if not discord_presence_ready(): return jsonify({"app_id": None, "activity": None, "message": "Discord status is turned off on this server."})
    p = _presence.get(u)
    if not p or not p.get("playing") or time.time() - p["t"] > 45: return jsonify({"app_id": c["discord_client_id"], "activity": None, "poll": 5})
    if not library_entry(p["rel"]): return jsonify({"app_id": c["discord_client_id"], "activity": None, "poll": 5})
    meta = _track_meta(p["rel"])
    meta["title"] = sanitize_title_and_extract_num(meta["title"], p["rel"])[0]
    meta["duration"] = meta["duration"] or 0
    base, site = (c.get("public_url") or base_url()).rstrip("/"), str(c.get("site_title") or "Axdio")
    start = int(p["t"] - (p.get("pos") or 0))
    act = {"type": 2, "status_display_type": 2, "details": meta["title"][:128], "state": meta["artist"][:128] or "Unknown artist",
           "timestamps": {"start": start, **({"end": int(start + meta["duration"])} if meta["duration"] else {})},
           "assets": {"large_text": (meta["album"] or meta["title"])[:128]}}
    shareable = c.get("feature_sharing", True) and not FED_REMOTE_RE.match(p["rel"]) and (not c.get("require_login") or c.get("share_previews", True))
    if shareable:
        sid = share_id("t", p["rel"])
        act["assets"]["large_image"] = f"{base}/track/{sid}/cover.jpg"
        act["buttons"] = [{"label": f"Listen on {site}"[:32], "url": f"{base}/track/{sid}"}]
    return jsonify({"app_id": c["discord_client_id"], "activity": act, "poll": 5})

# ============================================================
# PLUGINS
# ============================================================
# Plugins are made separately from Axdio, and nothing in Axdio or its image downloads music. An admin installs them on
# the Plugins page. They go into a Python environment of their own in config/plugins/env (see the top of this file) and
# can be updated or removed from there.
#
# The catalog says what can be installed: from the release tags of a GitHub repository, or from PyPI. An Axdio plugin is
# a Python package with a register(api) function. Once installed it's loaded into the server, and through `api` it can
# add admin pages, settings, admin routes under /api/admin/plugins/<id>/, hooks, and add-ons of its own to the catalog
# (packages it uses, which are then installed and updated here like any plugin).
import importlib, shlex

PLUGIN_API_VERSION = 1
PLUGIN_CATALOG = {
    "downloader": {"name": "Downloader", "package": "axdio-downloader", "module": "axdio_downloader", "axdio": True, "license": "MIT",
                   "github": "xo907/axdio-downloader", "home": "https://github.com/xo907/axdio-downloader",
                   "desc": "Adds a Downloader page that saves songs, albums and playlists from links, and lets the library audit replace wrong audio. It's a separate project with its own code, license and dependencies. Check that using it is allowed where you are, and only download music you have the right to copy."},
}
PLUGINS_FILE = PLUGINS_DIR / "plugins.json"
# Extra pip options for servers behind a mirror or proxy, e.g. "--index-url https://pypi.example.com/simple".
PLUGIN_PIP_ARGS = shlex.split(os.environ.get("PLUGIN_PIP_ARGS", ""))
# For working on a plugin: PLUGIN_SOURCES="downloader=/src/axdio-downloader" installs it from that folder instead.
PLUGIN_SOURCES = dict(x.strip().split("=", 1) for x in os.environ.get("PLUGIN_SOURCES", "").split(",") if "=" in x)
_plugins_lock = threading.RLock()
_plugin_job = {"state": "idle", "plugin": "", "action": "", "message": "", "log": collections.deque(maxlen=60), "started": 0}
_plugin_users = [0]                 # plugin modules in use right now (see plugin_module_session)
_plugin_reload = set()              # modules to load again once nothing is using them (after an update or removal)
_plugin_owner = {}                  # add-on id -> the plugin that added it
_plugin_loaded = {}                 # plugin id -> its module, once registered
_plugin_errors = {}                 # plugin id -> why it couldn't be loaded
PLUGIN_ROUTES = {}                  # (plugin id, path, method) -> handler
PLUGIN_PAGES = {}                   # plugin id -> admin pages it adds
PLUGIN_HOOKS = {}                   # hook name -> [(plugin id, function)]
_plugin_schema = {}                 # plugin id -> ids of the settings sections it added

def plugins_state():
    st = _load_json_file(PLUGINS_FILE, {})
    if not isinstance(st, dict): st = {}
    st.setdefault("plugins", {}); st.setdefault("latest", {})
    return st

def plugins_save(st):
    _save_json_file(PLUGINS_FILE, st)

def plugin_versions(env=None):
    """{distribution name: version} for what's installed in the plugin environment."""
    out = {}
    try: dists = list(importlib.metadata.distributions(path=plugin_site_dirs(env)))
    except Exception: return out
    for d in dists:
        # One unreadable package (say, one pip is still writing) mustn't hide the others.
        try:
            n = (d.metadata["Name"] or "").lower().replace("_", "-")
            if n: out[n] = d.version
        except Exception: continue
    return out

def plugin_name(pid):
    return (PLUGIN_CATALOG.get(pid) or {}).get("name") or pid

def plugin_version(pid):
    p = PLUGIN_CATALOG.get(pid)
    return plugin_versions().get(p["package"]) if p else None

def plugin_ready(pid):
    """True when the plugin (and whatever it needs) is installed."""
    have = plugin_versions()
    p = PLUGIN_CATALOG.get(pid)
    return bool(p and have.get(p["package"])) and all(have.get(PLUGIN_CATALOG[n]["package"]) for n in p.get("needs", []) if n in PLUGIN_CATALOG)

def plugin_command(pid):
    p = PLUGIN_CATALOG.get(pid) or {}
    exe = PLUGIN_ENV / "bin" / p.get("command", "")
    return str(exe) if p.get("command") and exe.exists() and plugin_ready(pid) else None

def plugin_hook(name):
    return [fn for _, fn in PLUGIN_HOOKS.get(name, [])]

class PluginMissing(Exception):
    def __init__(self, pid):
        self.pid = pid
        super().__init__(f"{plugin_name(pid)} isn't installed. An admin can install it under Plugins.")

class plugin_module_session:
    """`with plugin_module_session("some_module", pid) as mod: ...`. Raises PluginMissing when that plugin isn't
    installed. A newer version installed while the server runs is loaded here, once nothing is using the old one."""
    def __init__(self, module, pid):
        self.module, self.pid = module, pid
    def __enter__(self):
        m = self.module
        with _plugins_lock:
            if not plugin_version(self.pid): raise PluginMissing(self.pid)
            if m in _plugin_reload and _plugin_users[0] == 0:
                for k in [k for k in sys.modules if k == m or k.startswith(m + ".")]: del sys.modules[k]
                _plugin_reload.discard(m)
                importlib.invalidate_caches()
            _plugin_users[0] += 1
        try:
            return importlib.import_module(m)
        except Exception:
            self.__exit__()
            raise
    def __exit__(self, *exc):
        with _plugins_lock: _plugin_users[0] -= 1
        return False

class PluginAPI:
    """What an Axdio plugin gets in register(api). `api.core` is the server itself, for the helpers a plugin shares with
    it (the library, fingerprints, tags, the audit). Those change with Axdio, so a plugin says which versions it works
    with (AXDIO_API and AXDIO_MIN in its module)."""
    version = PLUGIN_API_VERSION

    def __init__(self, pid):
        self.pid = pid
        self.core = sys.modules[__name__]
        self.axdio_version = AXDIO_VERSION

    def route(self, path, methods=("GET",)):
        """An admin-only route at /api/admin/plugins/<plugin id>/<path>."""
        def deco(fn):
            for m in methods: PLUGIN_ROUTES[(self.pid, path.strip("/"), m.upper())] = fn
            return fn
        return deco

    def admin_page(self, page_id, title, icon, script, group="Library"):
        """A page in the admin panel, drawn by a script in the plugin's static/ folder (see web/admin/admin.js)."""
        PLUGIN_PAGES.setdefault(self.pid, []).append({"id": page_id, "title": title, "icon": icon, "group": group,
                                                      "script": f"/admin/plugins/{self.pid}/{script}"})

    def settings(self, section):
        """A settings section shaped like those in ADMIN_SCHEMA. Its values are read with cfg() as usual."""
        with _cfg_lock:
            ADMIN_SCHEMA[:] = [s for s in ADMIN_SCHEMA if s["id"] != section["id"]] + [section]
            for f in section["fields"]:
                SCHEMA_FIELDS[f["key"]] = f
                SCHEMA_DEFAULTS[f["key"]] = f["default"]
            _cfg_state["data"] = {}          # take the new defaults in
        _plugin_schema.setdefault(self.pid, []).append(section["id"])

    def hook(self, name, fn):
        """Hooks Axdio calls: "busy" (-> bool: don't change plugins now), "replace_audio" (the audit's repairs)."""
        PLUGIN_HOOKS.setdefault(name, []).append((self.pid, fn))

    def add_plugin(self, pid, entry):
        """An add-on: a package this plugin uses, shown on the Plugins page and installed and updated there. With
        "part": True it comes with the plugin (it's one of its dependencies) and can't be removed on its own."""
        entry = dict(entry)
        entry.setdefault("needs", [self.pid])
        PLUGIN_CATALOG[pid] = entry
        _plugin_owner[pid] = self.pid

    def module_session(self, module, pid):
        return plugin_module_session(module, pid)

def _plugin_unregister(pid):
    for k in [k for k in PLUGIN_ROUTES if k[0] == pid]: del PLUGIN_ROUTES[k]
    PLUGIN_PAGES.pop(pid, None)
    for name in list(PLUGIN_HOOKS): PLUGIN_HOOKS[name] = [h for h in PLUGIN_HOOKS[name] if h[0] != pid]
    with _cfg_lock:
        ids = set(_plugin_schema.pop(pid, []))
        for s in [s for s in ADMIN_SCHEMA if s["id"] in ids]:
            ADMIN_SCHEMA.remove(s)
            for f in s["fields"]:
                SCHEMA_FIELDS.pop(f["key"], None)
                SCHEMA_DEFAULTS.pop(f["key"], None)
        _cfg_state["data"] = {}
    for q in [q for q, o in _plugin_owner.items() if o == pid]:
        PLUGIN_CATALOG.pop(q, None)
        _plugin_owner.pop(q, None)
    mod = _plugin_loaded.pop(pid, None)
    if mod is not None and hasattr(mod, "unregister"):
        try: mod.unregister()
        except Exception as ex: print(f"[WARN] {plugin_name(pid)} didn't unload cleanly: {ex}")

def load_plugins():
    """Load the Axdio plugins that are installed, and let go of those that were removed or updated (once they're idle)."""
    have = plugin_versions()
    for pid, p in list(PLUGIN_CATALOG.items()):
        if not p.get("axdio"): continue
        v, mod = have.get(p["package"]), _plugin_loaded.get(pid)
        if mod is not None and (not v or p["module"] in _plugin_reload):
            if plugins_busy(): continue                     # the update takes over once the running job is done
            _plugin_unregister(pid)
            for k in [k for k in sys.modules if k == p["module"] or k.startswith(p["module"] + ".")]: del sys.modules[k]
            with _plugins_lock: _plugin_reload.discard(p["module"])
            importlib.invalidate_caches()
            mod = None
        if v and mod is None:
            try:
                mod = importlib.import_module(p["module"])
                need, least = getattr(mod, "AXDIO_API", PLUGIN_API_VERSION), getattr(mod, "AXDIO_MIN", "0")
                if need != PLUGIN_API_VERSION or _vtuple(AXDIO_VERSION) < _vtuple(least):
                    raise RuntimeError(f"version {v} needs Axdio {least} or newer with plugin API {need}")
                mod.register(PluginAPI(pid))
                _plugin_loaded[pid] = mod
                _plugin_errors.pop(pid, None)
                with _plugins_lock: _plugin_reload.discard(p["module"])      # this is the new version already
                print(f"[INFO] Plugin loaded: {p['name']} {v}")
            except Exception as ex:
                _plugin_unregister(pid)
                _plugin_errors[pid] = str(ex)
                print(f"[ERROR] Couldn't load the {p['name']} plugin: {ex}")
    # Add-ons that come with a plugin count as installed with it.
    st, changed = plugins_state(), False
    for pid, p in PLUGIN_CATALOG.items():
        if p.get("part") and pid not in st["plugins"] and have.get(p["package"]):
            st["plugins"][pid] = {"auto_update": False, "installed": time.time()}
            changed = True
    if changed:
        with _plugins_lock: plugins_save(st)

def pypi_latest(package):
    req = urllib.request.Request(f"https://pypi.org/pypi/{urllib.parse.quote(package)}/json", headers={"User-Agent": f"Axdio/{AXDIO_VERSION}"})
    with urllib.request.urlopen(req, timeout=20) as r: return str(json.load(r)["info"]["version"])

def github_latest(repo):
    """The newest version tag (v1.2.3) of a GitHub repository."""
    req = urllib.request.Request(f"https://api.github.com/repos/{repo}/tags?per_page=100",
                                 headers={"User-Agent": f"Axdio/{AXDIO_VERSION}", "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=20) as r: tags = json.load(r)
    versions = [t["name"].lstrip("v") for t in tags if re.fullmatch(r"v?\d+(\.\d+)*", str(t.get("name", "")))]
    if not versions: raise RuntimeError(f"{repo} has no releases yet")
    return max(versions, key=_vtuple)

def _source_version(path):
    m = re.search(r'(?m)^version\s*=\s*"([^"]+)"', (Path(path) / "pyproject.toml").read_text())
    return m.group(1) if m else "0"

def plugin_latest(pid):
    p = PLUGIN_CATALOG[pid]
    if pid in PLUGIN_SOURCES: return _source_version(PLUGIN_SOURCES[pid])
    return github_latest(p["github"]) if p.get("github") else pypi_latest(p["package"])

def plugins_check_latest():
    latest = {}
    for pid, p in list(PLUGIN_CATALOG.items()):
        try: latest[pid] = plugin_latest(pid)
        except Exception as ex: _plugin_log(f"Couldn't check {p['name']}: {ex}")
    with _plugins_lock:
        st = plugins_state()
        st["latest"].update(latest)
        st["checked"] = time.time()
        plugins_save(st)
    return latest

def _plugin_log(line):
    line = str(line).rstrip()
    if line: _plugin_job["log"].append(line[:300])

def _pip(args, env=None, timeout=1800):
    """Run pip for the plugin environment, streaming its output into the job log."""
    py = (env or PLUGIN_ENV) / "bin" / "python"
    cmd = [str(py), "-m", "pip", *args, "--disable-pip-version-check", "--no-input", "--no-cache-dir", "--progress-bar", "off", *PLUGIN_PIP_ARGS]
    _plugin_log("$ pip " + " ".join(a for a in args))
    last = ""
    deadline = time.time() + timeout
    with subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
                          env={**os.environ, "PIP_ROOT_USER_ACTION": "ignore", "PYTHONNOUSERSITE": "1"}) as proc:
        for line in iter(proc.stdout.readline, ""):
            if line.strip():
                last = line.strip()
                if not last.startswith(("Requirement already satisfied", "  ")): _plugin_log(last)
            if time.time() > deadline:
                proc.kill(); raise RuntimeError("pip took too long.")
        proc.wait()
    if proc.returncode != 0: raise RuntimeError(last or f"pip failed ({proc.returncode})")

def plugin_env_ok(env=None):
    """The environment exists and was made for this server's Python (an image with a newer Python needs a new one)."""
    env = env or PLUGIN_ENV
    return (env / "bin" / "python").exists() and (env / "lib" / PY_DIR / "site-packages").is_dir()

def _make_env(env):
    """A Python environment for plugins. It sees the server's own packages, so shared libraries aren't installed twice."""
    shutil.rmtree(env, ignore_errors=True)
    env.parent.mkdir(parents=True, exist_ok=True)
    r = subprocess.run([sys.executable, "-m", "venv", "--system-site-packages", "--without-pip", str(env)], capture_output=True, text=True, timeout=300)
    if r.returncode != 0: raise RuntimeError((r.stderr or r.stdout).strip()[-300:] or "Couldn't create the plugin environment.")

def _plugins_changed(modules):
    """Make installed or removed plugins visible to this process without a restart."""
    add_plugin_paths()
    importlib.invalidate_caches()
    with _plugins_lock: _plugin_reload.update(m for m in modules if m)

def _install_specs(pid):
    p = PLUGIN_CATALOG[pid]
    if pid in PLUGIN_SOURCES: return [PLUGIN_SOURCES[pid]]
    if p.get("github"):
        return [f"{p['package']} @ https://github.com/{p['github']}/archive/refs/tags/v{plugin_latest(pid)}.tar.gz"]
    return p.get("install") or [p["package"]]

def _requires(pid):
    out = []
    for q in PLUGIN_CATALOG[pid].get("needs", []) + [pid]:
        if q in PLUGIN_CATALOG and not (q != pid and PLUGIN_CATALOG[q].get("part")):
            out += [x for x in _install_specs(q) if x not in out]
    return out

def plugin_complete(pid):
    """Installed with everything it comes with."""
    have = plugin_versions()
    p = PLUGIN_CATALOG.get(pid) or {}
    return bool(have.get(p.get("package"))) and all(have.get(x) for x in p.get("parts", []))

def _needed_by(pid, installed):
    """Installed plugins that need this one (not counting what comes with it)."""
    return [q for q, p in PLUGIN_CATALOG.items() if pid in p.get("needs", []) and q in installed and not p.get("part")]

def _plugin_install(pid, update=False):
    p = PLUGIN_CATALOG[pid]
    pkgs = list(_install_specs(pid)) if update else _requires(pid)
    if not plugin_env_ok():
        _plugin_job["message"] = "Setting up a place for plugins…"
        _make_env(PLUGIN_ENV)
        for q in plugins_state()["plugins"]:   # everything installed before goes back in too
            if q in PLUGIN_CATALOG and not PLUGIN_CATALOG[q].get("part"): pkgs += [x for x in _requires(q) if x not in pkgs]
    before = plugin_versions()
    _plugin_job["message"] = f"{'Updating' if update else 'Installing'} {p['name']}…"
    _pip(["install", "--upgrade", *pkgs])
    after = plugin_versions()
    with _plugins_lock:
        st = plugins_state()
        for q in ([pid] if update else [n for n in p.get("needs", []) if n in PLUGIN_CATALOG] + [pid]):
            st["plugins"].setdefault(q, {"auto_update": False, "installed": time.time()})
        plugins_save(st)
    changed = [c.get("module") for c in PLUGIN_CATALOG.values() if before.get(c["package"]) != after.get(c["package"])]
    _plugins_changed(changed)
    v = after.get(p["package"]) or "?"
    if update and before.get(p["package"]) == v:
        return f"{p['name']} {v} is already the newest version."
    return f"{p['name']} {v} is {'updated' if update else 'installed'}."

def _plugin_remove(pid):
    p = PLUGIN_CATALOG[pid]
    addons = [q for q, o in _plugin_owner.items() if o == pid]
    with _plugins_lock:
        st = plugins_state()
        keep = [q for q in st["plugins"] if q != pid and q not in addons and q in PLUGIN_CATALOG and not PLUGIN_CATALOG[q].get("part")]
    if p.get("axdio"):
        _plugin_unregister(pid)                 # stop using it before its files go
        for k in [k for k in sys.modules if k == p["module"] or k.startswith(p["module"] + ".")]: del sys.modules[k]
    if keep:
        # Build the environment again with what's left, so nothing the removed plugin brought along stays behind.
        # The old one is kept until the new one works.
        _plugin_job["message"] = f"Removing {p['name']}…"
        pkgs = []
        for q in keep:
            pkgs += [x for x in _requires(q) if x not in pkgs]
        old = PLUGINS_DIR / "env.old"
        shutil.rmtree(old, ignore_errors=True)
        if PLUGIN_ENV.exists(): PLUGIN_ENV.rename(old)
        try:
            _make_env(PLUGIN_ENV)
            _pip(["install", *pkgs])
        except Exception:
            shutil.rmtree(PLUGIN_ENV, ignore_errors=True)
            if old.exists(): old.rename(PLUGIN_ENV)
            raise
        shutil.rmtree(old, ignore_errors=True)
    else:
        shutil.rmtree(PLUGIN_ENV, ignore_errors=True)
    with _plugins_lock:
        st = plugins_state()
        for q in [pid] + addons: st["plugins"].pop(q, None)
        plugins_save(st)
    _plugins_changed([p.get("module")])
    return f"{p['name']} is removed."

def plugins_busy():
    """Something that uses the plugins is running, so they shouldn't change underneath it."""
    busy = False
    for fn in plugin_hook("busy"):
        try: busy = busy or bool(fn())
        except Exception: pass
    return busy or bool(audit_state.get("fixing")) or _plugin_users[0] > 0

def start_plugin_job(pid, action, who=None):
    if pid not in PLUGIN_CATALOG: raise ValueError("There's no plugin by that name.")
    p = PLUGIN_CATALOG[pid]
    with _plugins_lock:
        if _plugin_job["state"] == "running": raise ValueError("Another plugin change is still running. Wait for it to finish.")
        installed = plugins_state()["plugins"]
        if action == "remove":
            if p.get("part"): raise ValueError(f"{p['name']} comes with {plugin_name(_plugin_owner.get(pid))}. Remove that instead.")
            if pid not in installed and not plugin_version(pid): raise ValueError(f"{p['name']} isn't installed.")
            users = _needed_by(pid, installed)
            if users: raise ValueError(f"{', '.join(plugin_name(q) for q in users)} needs {p['name']}. Remove that first.")
        if action in ("update", "remove") and plugins_busy():
            raise ValueError("Something that uses the plugins is running, like a download or a repair. Try again when it's finished.")
        _plugin_job.update(state="running", plugin=pid, action=action, message="Starting…", started=time.time(), versions=plugin_versions())
        _plugin_job["log"].clear()

    def run():
        try:
            msg = _plugin_remove(pid) if action == "remove" else _plugin_install(pid, update=(action == "update"))
            load_plugins()                      # before saying it's done, so its pages and routes are there when asked for
            _plugin_job.update(state="done", message=msg)
            activity("plugins", msg if who else f"{msg} (automatic update)", who)
        except Exception as ex:
            try: load_plugins()
            except Exception: pass
            _plugin_job.update(state="error", message=f"That didn't work: {ex}")
            activity("plugins", f"Couldn't {action} {p['name']}: {ex}", who, "warn")
    threading.Thread(target=run, daemon=True, name="plugin-" + action).start()

def plugins_view():
    # While plugins change, show what was there before (the environment may be half rebuilt).
    have = _plugin_job["versions"] if _plugin_job["state"] == "running" and _plugin_job.get("versions") is not None else plugin_versions()
    st = plugins_state()
    out = []
    order = [q for q in PLUGIN_CATALOG if q not in _plugin_owner]
    order = [x for q in order for x in [q] + [a for a, o in _plugin_owner.items() if o == q]]
    for pid in order:
        p = PLUGIN_CATALOG[pid]
        v = have.get(p["package"])
        out.append({"id": pid, "name": p["name"], "desc": p["desc"], "home": p["home"], "license": p["license"],
                    "source": "GitHub" if p.get("github") else "PyPI", "addon_of": plugin_name(_plugin_owner[pid]) if pid in _plugin_owner else None,
                    "part": bool(p.get("part")), "error": _plugin_errors.get(pid),
                    "needs": [plugin_name(n) for n in p.get("needs", []) if pid not in _plugin_owner],
                    "needed_by": [plugin_name(q) for q in _needed_by(pid, st["plugins"])],
                    "installed": v, "latest": st["latest"].get(pid), "auto_update": bool((st["plugins"].get(pid) or {}).get("auto_update")),
                    "update": bool(v and st["latest"].get(pid) and _vtuple(st["latest"][pid]) > _vtuple(v))})
    # Servers from before 2.8 had the downloader's tools installed as plugins of their own.
    moved = "yt-dlp" in st["plugins"] and not have.get(PLUGIN_CATALOG["downloader"]["package"])
    return {"plugins": out, "checked": st.get("checked"), "busy": plugins_busy(), "downloader_moved": moved,
            "job": {k: (list(v) if k == "log" else v) for k, v in _plugin_job.items() if k != "versions"},
            "check_hours": int(cfg().get("plugins_check_hours") or 24)}

def plugins_loop():
    """Look for new versions now and then, and install them for plugins that keep themselves up to date."""
    time.sleep(20)
    st = plugins_state()
    mine = [q for q in st["plugins"] if q in PLUGIN_CATALOG and not PLUGIN_CATALOG[q].get("part")]
    if mine and not plugin_env_ok():
        # A new image with a different Python can't use the old environment: put the same plugins back.
        print("[+] Reinstalling plugins for this server's Python...")
        first = next((q for q in mine if not _needed_by(q, mine)), mine[0])
        try: start_plugin_job(first, "install")
        except ValueError: pass
    time.sleep(100)
    while True:
        try:
            load_plugins()                          # updates that waited for a job to finish
            st = plugins_state()
            # Installed before a plugin came with more parts, or an add-on that went missing: complete them.
            for q in st["plugins"]:
                p = PLUGIN_CATALOG.get(q)
                if p and not p.get("part") and plugin_env_ok() and not plugin_complete(q) and _plugin_job["state"] != "running":
                    try: start_plugin_job(q, "install")
                    except ValueError: pass
                    break
            hours = max(1, int(cfg().get("plugins_check_hours") or 24))
            if st["plugins"] and time.time() - st.get("checked", 0) >= hours * 3600:
                plugins_check_latest()
            st = plugins_state()
            have = plugin_versions()
            for pid, rec in st["plugins"].items():
                p = PLUGIN_CATALOG.get(pid)
                if not p or not rec.get("auto_update"): continue
                v, latest = have.get(p["package"]), st["latest"].get(pid)
                if v and latest and _vtuple(latest) > _vtuple(v) and not plugins_busy() and _plugin_job["state"] != "running":
                    try: start_plugin_job(pid, "update")
                    except ValueError: pass
                    break   # one at a time; the next one goes on a later round
        except Exception as ex:
            print(f"[ERROR] Plugin updates: {ex}")
        time.sleep(600)

@app.route("/api/admin/v2/plugins")
def av2_plugins():
    return jsonify(plugins_view())

@app.route("/api/admin/v2/plugins/check", methods=["POST"])
def av2_plugins_check():
    plugins_check_latest()
    return jsonify(plugins_view())

@app.route("/api/admin/v2/plugins/ui")
def av2_plugins_ui():
    """Admin pages that installed plugins add."""
    return jsonify({"pages": [dict(pg, plugin=pid) for pid, pages in PLUGIN_PAGES.items() for pg in pages]})

@app.route("/api/admin/v2/plugins/<pid>", methods=["POST"])
def av2_plugin(pid):
    if pid not in PLUGIN_CATALOG: return jsonify({"error": "There's no plugin by that name."}), 404
    d = _json()
    if "auto_update" in d:
        with _plugins_lock:
            st = plugins_state()
            if pid not in st["plugins"]: return jsonify({"error": f"Install {plugin_name(pid)} first."}), 400
            st["plugins"][pid]["auto_update"] = bool(d["auto_update"])
            plugins_save(st)
        activity("plugins", f"{'Turned on' if d['auto_update'] else 'Turned off'} automatic updates for {plugin_name(pid)}", admin_name())
        return jsonify(plugins_view())
    action = d.get("action")
    if action not in ("install", "update", "remove"): return jsonify({"error": "Choose install, update or remove."}), 400
    try: start_plugin_job(pid, action, admin_name())
    except ValueError as ex: return jsonify({"error": str(ex)}), 409
    time.sleep(0.2)
    return jsonify(plugins_view())

@app.route("/api/admin/plugins/<pid>/<path:sub>", methods=["GET", "POST", "PUT", "DELETE"])
def plugin_admin_route(pid, sub):
    """Admin routes that plugins add (every /api/admin/ path needs an admin session)."""
    fn = PLUGIN_ROUTES.get((pid, sub.strip("/"), request.method))
    if not fn: return jsonify({"error": f"{plugin_name(pid)} isn't installed, or doesn't do that."}), 404
    return fn()

@app.route("/admin/plugins/<pid>/<path:name>")
def plugin_admin_file(pid, name):
    """Scripts for the admin pages that plugins add, from their static/ folder."""
    mod = _plugin_loaded.get(pid)
    if not session.get("is_admin") or mod is None: abort(404)
    base = (Path(mod.__file__).parent / "static").resolve()
    f = (base / name).resolve()
    if base not in f.parents or not f.is_file(): abort(404)
    r = send_file(str(f), max_age=0)
    r.headers["Cache-Control"] = "no-cache"
    return r

# ============================================================
# UPDATES
# ============================================================
# New versions are published as images (ghcr.io/xo907/axdio). The admin panel shows what's new and, when the container
# can reach Docker (the socket mounted in docker-compose.yml), updates in place: the new image is pulled, and a short-
# lived helper container stops this one, recreates it from the new image with the same settings (ports, folders,
# environment, networks, restart policy) and waits for it to report healthy. If it doesn't, the old container comes back.
import http.client, socket as _socket

UPDATE_IMAGE = os.environ.get("AXDIO_UPDATE_IMAGE", "ghcr.io/xo907/axdio").rstrip("/")
UPDATE_FILE = CONFIG_DIR / "update.json"
DOCKER_SOCK = "/var/run/docker.sock"
_update_lock = threading.Lock()
_update_job = {"state": "idle", "message": "", "log": collections.deque(maxlen=80)}
_update_cache = {"checked": 0, "latest": None, "versions": [], "error": "", "notes": {}}


class _DockerConnection(http.client.HTTPConnection):
    def __init__(self, timeout=60):
        super().__init__("docker", timeout=timeout)

    def connect(self):
        self.sock = _socket.socket(_socket.AF_UNIX, _socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(DOCKER_SOCK)


def docker_api(method, path, body=None, timeout=60, lines=None):
    """(status, decoded JSON or text) from the Docker Engine API. `lines(obj)` receives streamed JSON lines."""
    conn = _DockerConnection(timeout)
    try:
        data = json.dumps(body).encode() if body is not None else None
        conn.request(method, path, body=data, headers={"Content-Type": "application/json"} if data else {})
        r = conn.getresponse()
        if lines:
            buf = b""
            while True:
                chunk = r.read1(65536) if hasattr(r, "read1") else r.read(65536)
                if not chunk: break
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    try: lines(json.loads(line))
                    except ValueError: pass
            return r.status, None
        raw = r.read()
        try: return r.status, json.loads(raw) if raw else None
        except ValueError: return r.status, raw.decode("utf-8", "replace")
    finally:
        conn.close()


def self_container_id():
    try:
        m = re.search(r"/containers/([0-9a-f]{64})/", Path("/proc/self/mountinfo").read_text())
        if m: return m.group(1)
    except OSError: pass
    return _socket.gethostname()


def _split_ref(ref):
    """'ghcr.io/xo907/axdio:2.4' -> ('ghcr.io/xo907/axdio', '2.4'); digests and missing tags count as 'latest'."""
    ref = str(ref or "").split("@", 1)[0]
    name, _, tag = ref.rpartition(":") if ":" in ref.rsplit("/", 1)[-1] else (ref, "", "")
    return name, tag or "latest"


def update_setup():
    """Can this server update itself, and if not, why not?"""
    out = {"socket": os.path.exists(DOCKER_SOCK), "can_update": False, "reason": "", "image": "", "dev": False}
    if not out["socket"]:
        out["reason"] = "no-socket"
        return out
    try:
        st, me = docker_api("GET", f"/containers/{self_container_id()}/json", timeout=10)
    except PermissionError:
        out["reason"] = "no-permission"
        return out
    except OSError as ex:
        out.update(reason="no-docker", detail=str(ex))
        return out
    if st != 200 or not isinstance(me, dict):
        out.update(reason="not-found")
        return out
    ref = me["Config"].get("Image") or ""
    name, tag = _split_ref(ref)
    dev = [m.get("Destination") for m in me.get("Mounts") or [] if m.get("Destination") in ("/app/server.py", "/app/web")]
    out.update(image=ref, container=me.get("Name", "").lstrip("/"), container_id=me["Id"], tag=tag, dev=bool(dev))
    if name != UPDATE_IMAGE: out["reason"] = "other-image"
    elif dev: out["reason"] = "dev"
    elif not any(m.get("Destination") == "/app/config" for m in me.get("Mounts") or []): out["reason"] = "no-config-volume"
    else: out["can_update"] = True
    return out


def _registry_versions():
    """Version tags published for the image (e.g. 2.4.0)."""
    url = os.environ.get("AXDIO_UPDATE_TAGS_URL")
    if not url:
        host, _, repo = UPDATE_IMAGE.partition("/")
        token = json.loads(urllib.request.urlopen(urllib.request.Request(
            f"https://{host}/token?scope=repository:{repo}:pull", headers={"User-Agent": f"Axdio/{AXDIO_VERSION}"}), timeout=15).read())
        url = f"https://{host}/v2/{repo}/tags/list"
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token.get('token', '')}", "User-Agent": f"Axdio/{AXDIO_VERSION}"})
    else:
        req = urllib.request.Request(url, headers={"User-Agent": f"Axdio/{AXDIO_VERSION}"})
    tags = json.loads(urllib.request.urlopen(req, timeout=15).read()).get("tags") or []
    return sorted({t for t in tags if re.fullmatch(r"\d+\.\d+\.\d+", t)}, key=_vtuple)


def release_notes(version):
    """The changelog section of a version, from its tag on GitHub."""
    if version in _update_cache["notes"]: return _update_cache["notes"][version]
    notes = ""
    m = re.fullmatch(r"ghcr\.io/([^/]+)/([^/:]+)", UPDATE_IMAGE)
    if m:
        try:
            text = urllib.request.urlopen(urllib.request.Request(
                f"https://raw.githubusercontent.com/{m.group(1)}/{m.group(2)}/v{version}/CHANGELOG.md",
                headers={"User-Agent": f"Axdio/{AXDIO_VERSION}"}), timeout=15).read().decode("utf-8", "replace")
            sec = re.search(r"(?ms)^## %s\s*$(.*?)(?=^## |\Z)" % re.escape(version), text)
            notes = sec.group(1).strip() if sec else ""
        except Exception:
            notes = ""
    _update_cache["notes"][version] = notes
    return notes


def check_for_update(force=False):
    if not force and time.time() - _update_cache["checked"] < 3600 and _update_cache["latest"]: return _update_cache
    try:
        versions = _registry_versions()
        _update_cache.update(versions=versions, latest=versions[-1] if versions else None, error="", checked=time.time())
    except Exception as ex:
        _update_cache.update(error=f"Couldn't check for updates: {ex}", checked=time.time())
    latest = _update_cache["latest"]
    if latest and _vtuple(latest) > _vtuple(AXDIO_VERSION):
        seen = _load_json_file(UPDATE_FILE, {}).get("announced")
        if seen != latest:
            _update_state(announced=latest)
            activity("updates", f"Axdio {latest} is available (this server runs {AXDIO_VERSION})", None)
            try: send_discord_notification("Update available", f"Axdio **{latest}** is available. This server runs {AXDIO_VERSION}. Open the admin panel's Updates page to install it.")
            except Exception: pass
    return _update_cache


def _update_state(**kw):
    st = _load_json_file(UPDATE_FILE, {})
    st.update(kw)
    _save_json_file(UPDATE_FILE, st)
    return st


def _ulog(msg):
    _update_job["log"].append(f"{time.strftime('%H:%M:%S')} {msg}")
    _update_job["message"] = msg


def update_available():
    latest = _update_cache.get("latest")
    return bool(latest and _vtuple(latest) > _vtuple(AXDIO_VERSION))


def update_view():
    setup = update_setup()
    latest = _update_cache.get("latest")
    newer = [v for v in _update_cache.get("versions") or [] if _vtuple(v) > _vtuple(AXDIO_VERSION)]
    st = _load_json_file(UPDATE_FILE, {})
    return {"current": AXDIO_VERSION, "latest": latest, "available": update_available(), "checked": _update_cache.get("checked"),
            "error": _update_cache.get("error"), "notes": [{"version": v, "notes": release_notes(v)} for v in reversed(newer[-5:])],
            "setup": setup, "image": UPDATE_IMAGE, "job": {"state": _update_job["state"], "message": _update_job["message"], "log": list(_update_job["log"])},
            "last": {k: st.get(k) for k in ("state", "from", "to", "at", "message") if st.get(k)}}


def _config_source(me):
    for m in me.get("Mounts") or []:
        if m.get("Destination") == "/app/config":
            return m.get("Name") if m.get("Type") == "volume" else m.get("Source")
    return None


def _run_update(who):
    try:
        setup = update_setup()
        if not setup["can_update"]: raise RuntimeError("This server can't update itself (see the Updates page).")
        check_for_update(force=True)
        target = _update_cache.get("latest")
        if not target or _vtuple(target) <= _vtuple(AXDIO_VERSION): raise RuntimeError("Already up to date.")
        name, tag = _split_ref(setup["image"])
        # 'latest' follows the newest release; a pinned version tag moves to the new version.
        new_tag = tag if tag == "latest" else target
        new_ref = f"{UPDATE_IMAGE}:{new_tag}"
        st, me = docker_api("GET", f"/containers/{setup['container_id']}/json")
        # The running image's defaults, read now: once the tag moves to the new image, Docker may forget the old one.
        s, old_img = docker_api("GET", f"/images/{me['Image']}/json")
        old_base = (old_img or {}).get("Config") or {} if s == 200 else {}
        if not os.environ.get("AXDIO_UPDATE_NO_PULL"):
            _ulog(f"Downloading {new_ref}…")
            layers = {}
            def progress(obj):
                if obj.get("error"): raise RuntimeError(obj["error"])
                if obj.get("id") and obj.get("status"): layers[obj["id"]] = obj["status"]
                if obj.get("status", "").startswith(("Digest", "Status")): _ulog(obj["status"])
            s, _ = docker_api("POST", f"/images/create?fromImage={urllib.parse.quote(UPDATE_IMAGE)}&tag={urllib.parse.quote(new_tag)}", timeout=1800, lines=progress)
            if s != 200: raise RuntimeError(f"Docker couldn't download the image (HTTP {s}).")
        s, img = docker_api("GET", f"/images/{urllib.parse.quote(new_ref, safe='')}/json")
        if s != 200: raise RuntimeError(f"The image {new_ref} isn't there after downloading.")
        if img["Id"] == me["Image"]: raise RuntimeError("The downloaded image is the one already running.")
        version = ((img.get("Config") or {}).get("Labels") or {}).get("org.opencontainers.image.version") or target
        cfg_src = _config_source(me)
        sock_src = next((m.get("Source") for m in me.get("Mounts") or [] if m.get("Destination") == DOCKER_SOCK), DOCKER_SOCK)
        _update_state(state="restarting", **{"from": AXDIO_VERSION, "to": version, "at": time.time(), "message": "Restarting with the new version…",
                                             "by": who, "container": setup["container"], "old_image": me["Image"], "finished": None, "reported": None, "steps": []})
        activity("updates", f"Updating Axdio from {AXDIO_VERSION} to {version}", who, "warn")
        _ulog(f"Restarting with Axdio {version}. The server is back in about a minute.")
        # The helper runs from the new image (it's certain to exist); it only needs Python's standard library.
        helper = {"Image": img["Id"], "Entrypoint": ["python", "-c", UPDATER_SCRIPT], "Cmd": [], "User": "0:0",
                  "Env": [f"TARGET={me['Id']}", f"NEW_IMAGE={new_ref}", "STATE=/cfg/update.json", f"WANT_VERSION={version}",
                          "OLD_BASE=" + json.dumps({k: old_base.get(k) for k in ("Env", "Labels", "Cmd", "Entrypoint", "WorkingDir", "User", "Healthcheck",
                                                                                "ExposedPorts", "Volumes", "StopSignal", "Shell", "OnBuild")})],
                  "Labels": {"axdio.role": "updater"},
                  "HostConfig": {"Binds": [f"{sock_src}:/var/run/docker.sock", f"{cfg_src}:/cfg"], "AutoRemove": True, "NetworkMode": "none"}}
        s, made = docker_api("POST", f"/containers/create?name=axdio-updater-{uuid.uuid4().hex[:8]}", helper)
        if s != 201: raise RuntimeError(f"Couldn't start the update helper: {made}")
        s, _ = docker_api("POST", f"/containers/{made['Id']}/start")
        if s not in (204, 304): raise RuntimeError(f"Couldn't start the update helper (HTTP {s}).")
        _update_job["state"] = "restarting"
    except Exception as ex:
        _update_job["state"] = "error"
        _ulog(f"Update failed: {ex}")
        _update_state(state="failed", message=str(ex), at=time.time())
        activity("updates", f"Update failed: {ex}", who, "error")


def start_update(who=None):
    with _update_lock:
        if _update_job["state"] in ("running", "restarting"): raise ValueError("An update is already running.")
        if plugins_busy(): raise ValueError("A download or repair is running. Try again when it's finished.")
        _update_job.update(state="running", message="Starting…")
        _update_job["log"].clear()
    threading.Thread(target=_run_update, args=(who,), daemon=True, name="update").start()


def update_boot_check():
    """After a restart: record how an update went."""
    st = _load_json_file(UPDATE_FILE, {})
    if st.get("state") in ("restarting", "done") and st.get("to") == AXDIO_VERSION and st.get("finished") is None:
        _update_state(state="done", finished=time.time(), message=f"Updated from {st.get('from')} to {AXDIO_VERSION}")
        activity("updates", f"Updated Axdio from {st.get('from')} to {AXDIO_VERSION}", st.get("by"))
        # The previous image is no longer needed once nothing uses it and no tag points at it.
        try:
            s, img = docker_api("GET", f"/images/{st.get('old_image')}/json", timeout=10)
            if s == 200 and not [t for t in img.get("RepoTags") or [] if t != "<none>:<none>"]:
                docker_api("DELETE", f"/images/{st['old_image']}", timeout=60)
        except Exception: pass
    elif st.get("state") == "failed" and st.get("to") and st.get("to") != AXDIO_VERSION and not st.get("reported"):
        _update_state(reported=True)
        activity("updates", f"The update to {st.get('to')} didn't start properly, so {AXDIO_VERSION} came back: {st.get('message')}", None, "error")


def updates_loop():
    time.sleep(60)
    update_boot_check()
    while True:
        try:
            c = cfg()
            if c.get("updates_check", True):
                check_for_update()
                hour = int(c.get("updates_hour", 4))
                if (c.get("updates_auto") and update_available() and time.localtime().tm_hour == hour and _update_job["state"] in ("idle", "error")
                        and not plugins_busy() and update_setup()["can_update"]):
                    last = _load_json_file(UPDATE_FILE, {})
                    if not (last.get("state") == "failed" and last.get("to") == _update_cache.get("latest")):   # don't retry a failed version
                        start_update(None)
        except Exception as ex:
            print(f"[ERROR] Update check: {ex}")
        time.sleep(900)


@app.route("/api/admin/v2/updates")
def av2_updates():
    if request.args.get("check"): check_for_update(force=True)
    elif not _update_cache["checked"]: check_for_update()
    return jsonify(update_view())


@app.route("/api/admin/v2/updates/install", methods=["POST"])
def av2_updates_install():
    try: start_update(admin_name())
    except ValueError as ex: return jsonify({"error": str(ex)}), 409
    time.sleep(0.3)
    return jsonify(update_view())


# The helper that swaps the container. It runs in its own short-lived container (from the current image), so it keeps
# going while this server stops. Standard library only.
UPDATER_SCRIPT = r'''
import http.client, json, os, socket, time, urllib.parse
T, NEW, STATE = os.environ["TARGET"], os.environ["NEW_IMAGE"], os.environ["STATE"]

class C(http.client.HTTPConnection):
    def __init__(self): super().__init__("docker", timeout=120)
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); self.sock.settimeout(120); self.sock.connect("/var/run/docker.sock")

def api(method, path, body=None):
    c = C()
    try:
        c.request(method, path, body=json.dumps(body).encode() if body is not None else None, headers={"Content-Type": "application/json"})
        r = c.getresponse(); raw = r.read()
        try: return r.status, json.loads(raw) if raw else None
        except ValueError: return r.status, raw.decode("utf-8", "replace")
    finally: c.close()

def note(**kw):
    try: st = json.load(open(STATE))
    except Exception: st = {}
    st.update(kw); st.setdefault("steps", []).append(time.strftime("%H:%M:%S ") + kw.get("message", ""))
    tmp = STATE + ".tmp"
    with open(tmp, "w") as f: json.dump(st, f, indent=1)
    try:
        d = os.stat(os.path.dirname(STATE)); os.chown(tmp, d.st_uid, d.st_gid)
    except OSError: pass
    os.replace(tmp, STATE)

s, old = api("GET", f"/containers/{T}/json")
name = old["Name"].lstrip("/")
s, new_img = api("GET", f"/images/{urllib.parse.quote(NEW, safe='')}/json")
new_base = (new_img or {}).get("Config") or {}
base = json.loads(os.environ.get("OLD_BASE") or "{}")
if not base.get("Env"):
    # The old image's defaults are unknown: its system variables give way to the new image's; everything else stays.
    system = {e.split("=", 1)[0] for e in new_base.get("Env") or []} & {"PATH", "LANG", "GPG_KEY", "PYTHON_VERSION", "PYTHON_SHA256",
              "PYTHONDONTWRITEBYTECODE", "PYTHONUNBUFFERED", "PIP_NO_CACHE_DIR", "PIP_DISABLE_PIP_VERSION_CHECK"}
    base = dict(new_base, Env=[e for e in old["Config"].get("Env") or [] if e.split("=", 1)[0] in system])
cfg = dict(old["Config"])
# What the old image set by default gives way to the new image's defaults.
cfg["Env"] = [e for e in cfg.get("Env") or [] if e not in (base.get("Env") or [])]
cfg["Labels"] = {k: v for k, v in (cfg.get("Labels") or {}).items() if (base.get("Labels") or {}).get(k) != v}
for key in ("Cmd", "Entrypoint", "WorkingDir", "User", "Healthcheck", "ExposedPorts", "Volumes", "StopSignal", "Shell", "OnBuild"):
    if cfg.get(key) == base.get(key): cfg.pop(key, None)
if cfg.get("Hostname") == old["Id"][:12]: cfg.pop("Hostname", None)
cfg.pop("Domainname", None) if not cfg.get("Domainname") else None
cfg["Image"] = NEW
host = old["HostConfig"]
mode = host.get("NetworkMode") or ""
body = dict(cfg, HostConfig=host)
if mode not in ("host", "none") and not mode.startswith("container:"):
    eps = {}
    for net, ep in (old["NetworkSettings"].get("Networks") or {}).items():
        eps[net] = {"Aliases": [a for a in ep.get("Aliases") or [] if a != old["Id"][:12]] or None, "IPAMConfig": ep.get("IPAMConfig"),
                    "Links": ep.get("Links"), "DriverOpts": ep.get("DriverOpts")}
    body["NetworkingConfig"] = {"EndpointsConfig": eps}

def restore(why):
    note(state="failed", message=f"{why} Putting the previous version back.")
    api("POST", f"/containers/{T}/rename?name={urllib.parse.quote(name)}")
    s, _ = api("POST", f"/containers/{T}/start")
    note(state="failed", message=f"{why} The previous version is running again." if s in (204, 304) else f"{why} Starting the previous version failed too (HTTP {s}): start the '{name}' container by hand.")

note(state="restarting", message=f"Stopping {name}")
api("POST", f"/containers/{T}/rename?name={urllib.parse.quote(name + '-axdio-old')}")
api("POST", f"/containers/{T}/stop?t=30")
s, made = api("POST", f"/containers/create?name={urllib.parse.quote(name)}", body)
if s != 201:
    restore(f"Docker didn't create the new container (HTTP {s}: {str(made)[:200]}).")
    raise SystemExit(1)
new = made["Id"]
note(message=f"Starting the new version ({NEW})")
s, _ = api("POST", f"/containers/{new}/start")
ok, why, t0 = False, "", time.time()
while time.time() - t0 < 300 and s in (204, 304):
    time.sleep(3)
    s2, info = api("GET", f"/containers/{new}/json")
    state = (info or {}).get("State") or {}
    health = (state.get("Health") or {}).get("Status")
    if state.get("Status") in ("exited", "dead") or state.get("Restarting"):
        why = f"The new version stopped (exit code {state.get('ExitCode')})."; break
    if health == "healthy" or (health is None and state.get("Running") and time.time() - t0 > 30):
        ok = True; break
    if health == "unhealthy":
        why = "The new version started but doesn't answer."; break
else:
    why = why or ("The new version didn't start." if s not in (204, 304) else "The new version didn't become ready within 5 minutes.")
if ok:
    api("DELETE", f"/containers/{T}")
    note(state="done", message="The new version is running.")
else:
    s3, logs = api("GET", f"/containers/{new}/logs?stdout=1&stderr=1&tail=20")
    api("POST", f"/containers/{new}/stop?t=10")
    api("DELETE", f"/containers/{new}?force=1")
    note(new_logs=str(logs)[-2000:] if logs else "")
    restore(why)
'''

# ============================================================
# LISTENING PARTIES
# ============================================================
# People on this server listen together, in sync: one shared queue, everyone hearing the same moment of the same
# song. The server keeps the party's clock (what's playing, from where, since when) and advances the queue when a song
# ends; the apps play along and correct their drift continuously. Parties live in memory and end when everyone leaves.
# Updates reach members by long polling: a request waits until something changes, so a skip or a reaction arrives
# at once. Party chat is plain text (not end-to-end encrypted) and disappears with the party.
PARTY_REACTIONS = ["🔥", "❤️", "😂", "🎉", "👏", "🙌", "😭", "🤯", "💃", "🎶"]
PARTY_MAX_MEMBERS = 50
_parties = {}             # id -> party
_party_by_code = {}       # join code -> id
_party_of = {}            # username -> party id
_party_cv = threading.Condition(threading.RLock())

def party_on(): return bool(cfg().get("feature_party", True))


def _party_code():
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"            # no 0/O, 1/I
    while True:
        c = "".join(secrets.choice(alphabet) for _ in range(6))
        if c not in _party_by_code: return c


def _party_dur(rel):
    e = library_entry(rel) if rel else None
    return float((e or {}).get("duration") or 0)


def _party_pos(p, t=None):
    st = p["state"]
    if not st["rel"]: return 0.0
    pos = st["pos"] + ((t or time.time()) - st["at"] if st["playing"] else 0)
    return max(0.0, min(pos, st["dur"])) if st["dur"] else max(0.0, pos)


def _party_changed(p):
    p["rev"] += 1
    _party_cv.notify_all()


def _party_event(p, kind, user=None, **kw):
    p["feed"].append(dict(kw, id=uuid.uuid4().hex[:10], kind=kind, user=user, at=time.time()))


def _party_start(p, item):
    """Play a queue item now (from its start)."""
    st = p["state"]
    if st["rel"]: p["played"].append({"id": st["item"], "r": st["rel"], "by": st.get("by")})
    del p["played"][:-50]
    p["state"] = {"rel": item["r"], "item": item["id"], "by": item.get("by"), "playing": True, "pos": 0.0, "at": time.time(), "dur": _party_dur(item["r"])}


def _party_next(p, auto=False):
    if p["queue"]:
        _party_start(p, p["queue"].pop(0))
    else:
        st = p["state"]
        st.update(pos=_party_pos(p), at=time.time(), playing=False)
        if auto: _party_event(p, "system", text="That was the last song in the queue. Add more to keep the party going.")


def _party_tick(p):
    """Advance when the song has played to its end (the server knows every song's length)."""
    st = p["state"]
    if st["playing"] and st["dur"] and time.time() - st["at"] + st["pos"] >= st["dur"] - 0.15:
        _party_next(p, auto=True)
        _party_changed(p)
    now = time.time()
    gone = [u for u, m in p["members"].items() if now - m["seen"] > 75]     # closed the app without leaving
    for u in gone: _party_leave(p, u, quiet=True)


def _party_leave(p, u, quiet=False):
    if u not in p["members"]: return
    del p["members"][u]
    _party_of.pop(u, None)
    if not p["members"]:
        _party_end(p)
        return
    if p["host"] == u:
        p["host"] = min(p["members"], key=lambda x: p["members"][x]["joined"])
        _party_event(p, "system", text=f"{_party_name(p['host'])} is the host now.")
    if not quiet: _party_event(p, "leave", u)
    _party_changed(p)


def _party_end(p):
    p["ended"] = True
    for u in list(p["members"]): _party_of.pop(u, None)
    _parties.pop(p["id"], None)
    _party_by_code.pop(p["code"], None)
    _party_changed(p)


def _party_name(u):
    rec = users_data.get(u) or {}
    return rec.get("display_name") or u


def party_view(p, me):
    host = p["host"] == me
    return {"id": p["id"], "code": p["code"], "name": p["name"], "host": p["host"], "me": me, "rev": p["rev"], "now": time.time(),
            "ended": p.get("ended", False), "visible": p["visible"],
            "perm": dict(p["perm"]), "can_control": host or p["perm"]["control"], "can_add": host or p["perm"]["add"], "is_host": host,
            "members": [dict(user_card(u), host=u == p["host"], joined=m["joined"], keys=e2ee_public(users_data.get(u) or {}))
                        for u, m in sorted(p["members"].items(), key=lambda x: x[1]["joined"])],
            # Party chat is end-to-end encrypted: the chat key, sealed for each member's private-message key.
            "keyv": p.get("keyv", 0), "my_wrap": (p.get("wraps") or {}).get(p.get("keyv", 0), {}).get(me),
            "wrapped": sorted((p.get("wraps") or {}).get(p.get("keyv", 0), {})),
            "state": dict(p["state"], pos=_party_pos(p), at=time.time()),
            "queue": p["queue"][:200], "queue_len": len(p["queue"]), "feed": list(p["feed"]), "reactions": PARTY_REACTIONS}


def _party_for(pid, u):
    p = _parties.get(pid)
    if not p or u not in p["members"]: abort(Response(json.dumps({"error": "You're not in this party (it may have ended).", "gone": True}), 410, mimetype="application/json"))
    p["members"][u]["seen"] = time.time()
    return p


def _party_join(p, u):
    old = _party_of.get(u)
    if old and old != p["id"] and old in _parties: _party_leave(_parties[old], u)
    if u not in p["members"]:
        if len(p["members"]) >= PARTY_MAX_MEMBERS: raise ValueError("This party is full.")
        p["members"][u] = {"joined": time.time(), "seen": time.time()}
        _party_event(p, "join", u)
    _party_of[u] = p["id"]
    _party_changed(p)


def _party_visible_to(p, u):
    """Friends of anyone in a visible party can see it and join."""
    if not p["visible"] or not social_on(): return False
    mine = set(social_rec(users_data.get(u) or {}).get("friends") or [])
    return bool(mine & set(p["members"]))


def party_badge(friend, viewer):
    """The party a friend is in, if the viewer may join it (for Friend Activity)."""
    p = _parties.get(_party_of.get(friend) or "")
    if not p or not _party_visible_to(p, viewer): return None
    return {"id": p["id"], "code": p["code"], "name": p["name"], "members": len(p["members"])}


def _party_rels(values):
    out = []
    for r in values if isinstance(values, list) else []:
        r = str(r or "")
        if r and library_entry(r) is not None: out.append(r)
    return out[:500]


@app.route("/api/party", methods=["GET", "POST"])
def party_home():
    u = _me()
    with _party_cv:
        if request.method == "POST":
            d = _json()
            name = re.sub(r"\s+", " ", str(d.get("name") or "")).strip()[:60] or f"{_party_name(u)}'s party"
            pid = "pty_" + secrets.token_urlsafe(9)
            p = {"id": pid, "code": _party_code(), "name": name, "host": u, "created": time.time(), "members": {}, "rev": 0, "keyv": 0, "wraps": {},
                 "perm": {"add": True, "control": False}, "visible": True, "queue": [], "played": [],
                 "feed": collections.deque(maxlen=80), "ended": False,
                 "state": {"rel": None, "item": None, "by": None, "playing": False, "pos": 0.0, "at": time.time(), "dur": 0.0}}
            _parties[pid] = p
            _party_by_code[p["code"]] = pid
            _party_join(p, u)
            # Start with what the host is playing, if anything.
            rels = _party_rels(d.get("queue") or [])
            if rels:
                p["queue"] = [{"id": uuid.uuid4().hex[:8], "r": r, "by": u} for r in rels]
                _party_start(p, p["queue"].pop(0))
                if d.get("pos"): p["state"]["pos"] = max(0.0, float(d["pos"]))
            activity("party", f"Started a listening party ({name})", u)
            events_add(u, "party_host", pid)
            return jsonify(party_view(p, u))
        mine = _parties.get(_party_of.get(u) or "")
        live = [{"id": p["id"], "code": p["code"], "name": p["name"], "host": user_card(p["host"]), "members": len(p["members"]),
                 "now": {"rel": p["state"]["rel"], "playing": p["state"]["playing"]}}
                for p in _parties.values() if p is not mine and _party_visible_to(p, u)]
        return jsonify({"party": party_view(mine, u) if mine else None, "live": live, "reactions": PARTY_REACTIONS})


@app.route("/api/party/join", methods=["POST"])
def party_join():
    u = _me()
    d = _json()
    code = re.sub(r"[^A-Z0-9]", "", str(d.get("code") or "").upper())
    with _party_cv:
        p = _parties.get(_party_by_code.get(code, "")) or _parties.get(str(d.get("id") or ""))
        if p and d.get("id") and not code and not _party_visible_to(p, u) and u not in p["members"]: p = None
        if not p: return jsonify({"error": "There's no live party with that code."}), 404
        try: _party_join(p, u)
        except ValueError as ex: return jsonify({"error": str(ex)}), 409
        events_add(u, "party_join", p["id"])
        return jsonify(party_view(p, u))


@app.route("/api/party/<pid>/wait")
def party_wait(pid):
    """Long poll: answers as soon as the party changes (or after 25 s with no change)."""
    u = _me()
    since = request.args.get("rev", type=int, default=-1)
    deadline = time.time() + 25
    with _party_cv:
        p = _party_for(pid, u)
        _party_tick(p)
        while p["rev"] <= since and not p["ended"] and time.time() < deadline:
            st = p["state"]
            wake = deadline - time.time()
            if st["playing"] and st["dur"]: wake = min(wake, max(0.05, st["dur"] - _party_pos(p)))
            _party_cv.wait(timeout=max(0.05, min(wake, 20)))
            if u not in p["members"]: break
            p["members"][u]["seen"] = time.time()
            _party_tick(p)
        if p["ended"] or u not in p["members"]:
            return jsonify({"error": "The party has ended.", "gone": True}), 410
        return jsonify(party_view(p, u))


@app.route("/api/party/<pid>", methods=["POST"])
def party_op(pid):
    u = _me()
    d = _json()
    op = str(d.get("op") or "")
    with _party_cv:
        p = _party_for(pid, u)
        host = p["host"] == u
        control, add = host or p["perm"]["control"], host or p["perm"]["add"]
        st = p["state"]
        need = {"play": "control", "pause": "control", "resume": "control", "seek": "control", "next": "control", "prev": "control",
                "jump": "control", "add": "add", "remove": "add", "move": "control", "settings": "host", "kick": "host", "end": "host"}.get(op)
        if need == "host" and not host: return jsonify({"error": "Only the host can do that."}), 403
        if need == "control" and not control: return jsonify({"error": "The host controls playback in this party."}), 403
        if need == "add" and not add: return jsonify({"error": "The host is choosing the songs in this party."}), 403
        if op == "play":                                       # play a song now, for everyone
            rels = _party_rels(d.get("rels") or [d.get("rel")])
            if not rels: return jsonify({"error": "That song isn't in the library."}), 400
            items = [{"id": uuid.uuid4().hex[:8], "r": r, "by": u} for r in rels]
            p["queue"][0:0] = items[1:]
            _party_start(p, items[0])
            _party_event(p, "play", u, rel=rels[0])
        elif op == "pause" and st["playing"]:
            st.update(pos=_party_pos(p), at=time.time(), playing=False)
        elif op == "resume" and st["rel"] and not st["playing"]:
            if st["dur"] and st["pos"] >= st["dur"] - 0.5: _party_next(p)
            else: st.update(at=time.time(), playing=True)
        elif op == "seek" and st["rel"]:
            st.update(pos=max(0.0, min(float(d.get("pos") or 0), st["dur"] or 1e9)), at=time.time())
        elif op == "next":
            _party_next(p)
        elif op == "prev":
            if _party_pos(p) > 3 or not p["played"]: st.update(pos=0.0, at=time.time())
            else:
                back = p["played"].pop()
                if st["rel"]: p["queue"].insert(0, {"id": st["item"], "r": st["rel"], "by": st.get("by")})
                st.update(rel=back["r"], item=back["id"], by=back.get("by"), pos=0.0, at=time.time(), playing=True, dur=_party_dur(back["r"]))
        elif op == "jump":
            i = next((i for i, it in enumerate(p["queue"]) if it["id"] == d.get("id")), None)
            if i is None: return jsonify({"error": "That song isn't in the queue any more."}), 404
            item = p["queue"].pop(i)
            _party_start(p, item)
        elif op == "add":
            rels = _party_rels(d.get("rels") or [])
            if not rels: return jsonify({"error": "Nothing to add."}), 400
            if len(p["queue"]) + len(rels) > 1000: return jsonify({"error": "The queue is full."}), 400
            items = [{"id": uuid.uuid4().hex[:8], "r": r, "by": u} for r in rels]
            if d.get("next"): p["queue"][0:0] = items
            else: p["queue"].extend(items)
            _party_event(p, "add", u, rel=rels[0], count=len(rels))
            if not st["rel"] or (not st["playing"] and st["dur"] and _party_pos(p) >= st["dur"] - 0.5): _party_next(p)
        elif op == "remove":
            it = next((it for it in p["queue"] if it["id"] == d.get("id")), None)
            if not it: return jsonify({"error": "That song isn't in the queue any more."}), 404
            if not control and it.get("by") != u: return jsonify({"error": "You can remove only the songs you added."}), 403
            p["queue"].remove(it)
        elif op == "move":
            i = next((i for i, it in enumerate(p["queue"]) if it["id"] == d.get("id")), None)
            if i is None: return jsonify({"error": "That song isn't in the queue any more."}), 404
            item = p["queue"].pop(i)
            p["queue"].insert(max(0, min(int(d.get("to") or 0), len(p["queue"]))), item)
        elif op == "react":
            emoji = str(d.get("emoji") or "")
            if emoji not in PARTY_REACTIONS: return jsonify({"error": "Pick one of the party reactions."}), 400
            if not rate_ok(("party-react", u), 8, 5): return jsonify({"error": "Slow down a little."}), 429
            _party_event(p, "react", u, emoji=emoji)
        elif op == "chat":
            # Only ciphertext: the apps encrypt with the party's chat key, which the server never sees.
            v = d.get("v")
            if not (isinstance(v, int) and 1 <= v <= p.get("keyv", 0) and _sealed(d, 1600)):
                return jsonify({"error": "Party chat is end-to-end encrypted. Update the app to join in."}), 400
            if not rate_ok(("party-chat", u), 6, 10): return jsonify({"error": "Slow down a little."}), 429
            _party_event(p, "chat", u, v=v, iv=d["iv"], ct=d["ct"])
        elif op == "keys":
            # The chat key, sealed for members. A new key (the next version) comes from the host, or from anyone for the
            # very first one; more members can be added to the current one by whoever already has it.
            v, wraps = d.get("v"), d.get("wraps")
            cur = p.get("keyv", 0)
            ok = lambda w: isinstance(w, dict) and _sealed(w, 200) and _b64(w.get("e"), PUBKEY_LEN, PUBKEY_LEN) and _b64(w.get("sig"), 40, 200) and w.get("by") == u
            if not (isinstance(wraps, dict) and wraps and all(k in p["members"] and ok(w) for k, w in wraps.items())):
                return jsonify({"error": "Those keys aren't right."}), 400
            if v == cur + 1 and (cur == 0 or u == p["host"]) and u in wraps:
                p.setdefault("wraps", {})[v] = {k: {x: w[x] for x in ("e", "iv", "ct", "sig", "by")} for k, w in wraps.items()}
                p["keyv"] = v
            elif v == cur and cur:
                have = p["wraps"][cur]
                for k, w in wraps.items(): have.setdefault(k, {x: w[x] for x in ("e", "iv", "ct", "sig", "by")})
            else:
                return jsonify({"error": "The party's key just changed.", "stale": True}), 409
        elif op == "settings":
            for k in ("add", "control"):
                if k in d: p["perm"][k] = bool(d[k])
            if "visible" in d: p["visible"] = bool(d["visible"])
            if d.get("name"): p["name"] = re.sub(r"\s+", " ", str(d["name"])).strip()[:60] or p["name"]
        elif op == "kick":
            who = str(d.get("user") or "")
            if who == u or who not in p["members"]: return jsonify({"error": "They're not in the party."}), 400
            _party_leave(p, who, quiet=True)
            _party_event(p, "system", text=f"{_party_name(who)} was removed from the party.")
        elif op == "host":
            who = str(d.get("user") or "")
            if not host or who not in p["members"]: return jsonify({"error": "Only the host can hand over."}), 403
            p["host"] = who
            _party_event(p, "system", text=f"{_party_name(who)} is the host now.")
        elif op == "ended":                                    # an app reached the end of the song (its length was unknown)
            if d.get("item") == st["item"] and st["playing"]: _party_next(p, auto=True)
            else: return jsonify(party_view(p, u))
        elif op == "duration":
            dur = float(d.get("dur") or 0)
            if d.get("item") == st["item"] and 1 < dur < 7200 and not st["dur"]: st["dur"] = dur
            else: return jsonify(party_view(p, u))
        elif op == "leave":
            _party_leave(p, u)
            return jsonify({"left": True})
        elif op == "end":
            _party_event(p, "system", text="The host ended the party.")
            _party_end(p)
            activity("party", f"Ended the listening party {p['name']}", u)
            return jsonify({"ended": True})
        elif op not in ("pause", "resume", "seek"):
            return jsonify({"error": "Unknown party action."}), 400
        _party_changed(p)
        return jsonify(party_view(p, u))


@app.route("/party/<code>")
def party_link(code):
    """Invitation links open the app, which joins the party."""
    code = re.sub(r"[^A-Za-z0-9]", "", code).upper()[:6]
    return redirect(f"/?party={code}")


def party_stats():
    with _party_cv:
        return {"parties": len(_parties), "listeners": sum(len(p["members"]) for p in _parties.values())}

# ============================================================
# REWIND: each listener's year (or month) in music
# ============================================================
# Every counted play is logged with its time (the plays table in axdio.db). History from before the log existed is
# brought in once, one row per song at the time it was last played, flagged `b` so it counts towards top songs and
# minutes but not towards times of day. The numbers are only ever shown to the listener they belong to.
def rewind_on(): return bool(cfg().get("feature_rewind", True))

def log_play(username, rel_path):
    meta = library_entry(rel_path)
    secs = float((meta or {}).get("duration") or 0) or 200.0
    with _db_lock:
        db().execute("INSERT INTO plays (user, ts, rel, secs) VALUES (?, ?, ?, ?)", (username, time.time(), rel_path, min(secs, 3600.0)))

def rewind_backfill():
    with _db_lock:
        if db().execute("SELECT value FROM kv WHERE key = 'plays_backfilled'").fetchone(): return
    rows = []
    with users_lock:
        for u, rec in users_data.items():
            for h in rec.get("history") or []:
                rel, ts = h.get("rel_path"), _iso_ts(h.get("last_played"))
                if rel and ts: rows.append((u, ts, rel, float((library_entry(rel) or {}).get("duration") or 200.0), max(1, int(h.get("count") or 1))))
    with _db_lock:
        conn = db()
        conn.execute("BEGIN")
        conn.executemany("INSERT INTO plays (user, ts, rel, secs, n, b) VALUES (?, ?, ?, ?, ?, 1)", rows)
        conn.execute("INSERT OR REPLACE INTO kv (key, value) VALUES ('plays_backfilled', ?)", (str(time.time()),))
        conn.execute("COMMIT")
    if rows: print(f"[INFO] Rewind: brought in {len(rows)} songs from listening history")

PERSONAS = [  # (from hour, to hour, name, line)
    (5, 11, "Early bird", "Your music starts with the sunrise."),
    (11, 17, "Daydreamer", "Your soundtrack runs through the working day."),
    (17, 22, "Golden hour", "You save your best listening for the evening."),
    (22, 29, "Night owl", "You come alive after dark."),
]

def rewind_stats(u, start, end, tz):
    """Numbers for plays between two UTC timestamps; `tz` is the viewer's UTC offset in minutes (JS getTimezoneOffset)."""
    with _db_lock:
        rows = db().execute("SELECT ts, rel, secs, n, b FROM plays WHERE user = ? AND ts >= ? AND ts < ?", (u, start, end)).fetchall()
        firsts = dict(db().execute("SELECT rel, MIN(ts) FROM plays WHERE user = ? GROUP BY rel", (u,)).fetchall())
        since = (db().execute("SELECT MIN(ts) FROM plays WHERE user = ? AND b = 0", (u,)).fetchone() or (None,))[0]
    local = lambda ts: datetime.utcfromtimestamp(ts - tz * 60)
    songs, artists, albums, art_mins, art_rel, alb_rel = Counter(), Counter(), Counter(), Counter(), {}, {}
    hours, weekdays, day_mins, day_song, months = [0] * 24, [0] * 7, Counter(), Counter(), [0.0] * 12
    total_secs = plays = 0
    for ts, rel, secs, n, b in rows:
        meta = library_entry(rel)
        if not isinstance(meta, dict): continue
        plays += n
        total_secs += secs * n
        songs[rel] += n
        a = extract_primary_artist(meta.get("artist"), meta.get("album_artist"))
        if a != "Unknown Artist":
            artists[a] += n; art_mins[a] += secs * n; art_rel.setdefault(a, rel)
        album = (meta.get("album") or "").strip()
        if album:
            key = (album, meta.get("album_artist") or meta.get("artist") or "")
            albums[key] += n; alb_rel.setdefault(key, rel)
        d = local(ts)
        months[d.month - 1] += secs * n / 60
        day_mins[d.date()] += secs * n / 60
        if not b:
            hours[d.hour] += n; weekdays[d.weekday()] += n
            day_song[(d.date(), rel)] += n
    song_out = lambda rel, c: dict(rel=rel, title=(library_entry(rel) or {}).get("title") or Path(rel).stem,
                                   artist=(library_entry(rel) or {}).get("artist") or "", plays=c)
    out = {"minutes": round(total_secs / 60), "plays": plays, "songs": len(songs), "artists": len(artists), "albums": len(albums),
           "top_songs": [song_out(r, c) for r, c in songs.most_common(10)],
           "top_artists": [{"name": a, "plays": c, "minutes": round(art_mins[a] / 60), "rel": art_rel[a]} for a, c in artists.most_common(10)],
           "top_albums": [{"title": k[0], "artist": k[1], "plays": c, "rel": alb_rel[k]} for k, c in albums.most_common(5)],
           "hours": hours, "weekdays": weekdays, "months": [round(m) for m in months],
           "since": since}
    if sum(hours):
        best = max(PERSONAS, key=lambda p: sum(hours[h % 24] for h in range(p[0], p[1])))
        out["persona"] = {"name": best[2], "line": best[3], "peak": max(range(24), key=lambda h: hours[h])}
    if day_mins:
        day, mins = max(day_mins.items(), key=lambda kv: kv[1])
        out["busiest"] = {"date": day.isoformat(), "minutes": round(mins)}
        days, best_run, run, prev = sorted(day_mins), 1, 1, None
        for dd in days:
            run = run + 1 if prev and (dd - prev).days == 1 else 1
            best_run, prev = max(best_run, run), dd
        out["streak"] = best_run
        out["active_days"] = len(days)
    if day_song:
        (day, rel), c = day_song.most_common(1)[0]
        if c >= 3: out["on_repeat"] = dict(song_out(rel, c), date=day.isoformat())
    found = [r for r in songs if start <= (firsts.get(r) or 0) < end]
    out["discoveries"] = len(found)
    if found: out["top_find"] = song_out(max(found, key=lambda r: songs[r]), songs[max(found, key=lambda r: songs[r])])
    return out

@app.route("/api/rewind")
def api_rewind():
    u = _me()
    tz = max(-900, min(900, request.args.get("tz", 0, type=int)))
    now_local = datetime.utcfromtimestamp(time.time() - tz * 60)
    period = request.args.get("period", "year")
    y = request.args.get("y", now_local.year, type=int)
    m = request.args.get("m", now_local.month, type=int)
    to_utc = lambda d: (d - datetime(1970, 1, 1)).total_seconds() + tz * 60
    if period == "month" and 1 <= m <= 12 and 2000 <= y <= 2100:
        start, end = datetime(y, m, 1), datetime(y + (m == 12), m % 12 + 1, 1)
        label = start.strftime("%B %Y")
    elif period == "year" and 2000 <= y <= 2100:
        start, end = datetime(y, 1, 1), datetime(y + 1, 1, 1)
        label = str(y)
    else:
        period, start, end, label = "all", datetime(2000, 1, 1), datetime(2100, 1, 1), "All time"
    stats = rewind_stats(u, to_utc(start), to_utc(end), tz)
    with _db_lock:
        years = [int(r[0]) for r in db().execute("SELECT DISTINCT CAST(strftime('%Y', ts - ?, 'unixepoch') AS INTEGER) FROM plays WHERE user = ? ORDER BY 1 DESC", (tz * 60, u))]
    return jsonify(dict(stats, period=period, label=label, year=y, month=m, years=years,
                        name=(users_data.get(u) or {}).get("display_name") or u))

# ============================================================
# SMART TRANSITIONS: loudness and silence of each song
# ============================================================
# The apps trim silence at the start and end of songs, time crossfades to where a song really ends (its fade-out),
# and can even out loudness between songs. For that each song is measured once with ffmpeg's EBU R128 meter (a
# loudness value every 100 ms), in the background at low priority, one song at a time. Results are cached in axdio.db
# and redone only when the file changes.
ANALYSIS_VERSION = 3
SILENCE_LUFS = -50.0
_an_queue = collections.deque()
_an_waiting = set()
_an_lock = threading.Lock()
_an_wake = threading.Event()
_EBU_FRAME = re.compile(r"t:\s*([\d.]+)\s+TARGET:.*?M:\s*(-?[\d.]+|-inf|nan)")
_EBU_I = re.compile(r"Integrated loudness:\s*I:\s*(-?[\d.]+) LUFS")

def smart_on(): return bool(cfg().get("feature_smart", True))

def measure_song(path):
    """Loudness (LUFS) and where a song's sound starts, reaches full level, starts to fade and ends, in seconds."""
    cmd = ["nice", "-n", "15", "ffmpeg", "-hide_banner", "-nostats", "-nostdin", "-i", str(path), "-map", "0:a:0",
           "-af", "ebur128=framelog=info", "-f", "null", "-"]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    frames = [(float(t), float(m) if m not in ("-inf", "nan") else -120.0) for t, m in _EBU_FRAME.findall(p.stderr)]
    got = _EBU_I.search(p.stderr)
    if not frames or not got: return None
    lufs, dur = float(got.group(1)), frames[-1][0]
    loud = [t for t, m in frames if m > SILENCE_LUFS]
    if not loud: return {"v": ANALYSIS_VERSION, "lufs": lufs, "dur": dur, "start": 0, "end": dur, "intro": 0, "outro": dur, "hook": 0}
    body = [t for t, m in frames if m > lufs - 10]
    full = [t for t, m in frames if m > lufs - 3]      # the song at its usual level: after the last of it, a fade-out
    # Momentary loudness covers the 400 ms before each timestamp (one every 100 ms): the first window with sound ends
    # just after the sound starts, and the last one ends 300-400 ms after it stops.
    start = max(0.0, loud[0] - 0.2)
    end = max(start, min(dur, loud[-1] - 0.15))
    intro = max(start, body[0] - 0.2) if body else start
    outro = min(end, max(intro, full[-1] - 0.2)) if full else end
    # The hook: the most energetic 15 seconds, looked for between 15% and 75% of the way in (past the intro, before the outro).
    hook, win = dur * .33, max(1, int(round(15 / max(.05, (frames[-1][0] - frames[0][0]) / max(1, len(frames) - 1)))))
    if dur >= 40 and len(frames) > win:
        energy = [0.0]
        for _, m in frames: energy.append(energy[-1] + 10 ** (max(m, -70.0) / 10))
        best = -1.0
        for i in range(len(frames) - win):
            t0 = frames[i][0] - 0.4
            if dur * .15 <= t0 <= dur * .75 and energy[i + win] - energy[i] > best: best, hook = energy[i + win] - energy[i], t0
    return {"v": ANALYSIS_VERSION, "lufs": round(lufs, 1), "dur": round(dur, 2), "start": round(start, 2), "end": round(end, 2),
            "intro": round(intro, 2), "outro": round(outro, 2), "hook": round(max(0.0, hook), 1)}

def analysis_cached(rel):
    path = resolve_safe_music_file(rel)
    if not path or not path.is_file(): return None, None
    mtime = path.stat().st_mtime
    with _db_lock: row = db().execute("SELECT mtime, data FROM analysis WHERE rel = ?", (rel,)).fetchone()
    if row and abs(row[0] - mtime) < 1:
        d = json.loads(row[1])
        if d.get("v") == ANALYSIS_VERSION: return d, path
    return None, path

def analysis_worker():
    while True:
        _an_wake.wait()
        with _an_lock:
            if not _an_queue: _an_wake.clear(); continue
            rel = _an_queue.popleft()
        try:
            data, path = analysis_cached(rel)
            if path and not data:
                mtime = path.stat().st_mtime
                data = measure_song(path) or {"v": ANALYSIS_VERSION, "failed": True}
                with _db_lock:
                    db().execute("INSERT OR REPLACE INTO analysis (rel, mtime, data) VALUES (?, ?, ?)", (rel, mtime, json.dumps(data)))
        except Exception as ex:
            print(f"[WARN] Couldn't measure {rel}: {ex}")
        finally:
            with _an_lock: _an_waiting.discard(rel)

@app.route("/api/analysis")
def api_analysis():
    """Measurements for up to four songs. Ones not measured yet are queued and come back as null; ask again later."""
    if not smart_on(): return jsonify({"off": True, "analysis": {}})
    rels = [r for r in request.args.getlist("rel")[:4] if r and not FED_REMOTE_RE.match(r)]
    now_rel = request.args.get("now")
    out = {}
    for rel in rels:
        data, path = analysis_cached(rel)
        out[rel] = data
        if data or not path: continue
        with _an_lock:
            if rel in _an_waiting:
                if rel == now_rel and rel in _an_queue: _an_queue.remove(rel); _an_queue.appendleft(rel)
                continue
            if len(_an_queue) >= 40: continue
            _an_waiting.add(rel)
            if rel == now_rel: _an_queue.appendleft(rel)
            else: _an_queue.append(rel)
            _an_wake.set()
    return jsonify({"analysis": out})

# ============================================================
# AXDIO DAILY: name today's song
# ============================================================
# One song a day for everyone on the server (by UTC date), picked from what's popular here. Listeners hear 1 second
# of it, then 2, 4, 7, 11 and 16 as they guess or skip. The clips are cut once a day without tags, and a clip is only
# handed out once a listener has used enough tries to unlock it, so the answer can't be read ahead of time.
DAILY_STAGES = (1, 2, 4, 7, 11, 16)
DAILY_EPOCH = datetime(2026, 9, 25).date()
DAILY_DIR = CONFIG_DIR / "daily"
_daily_lock = threading.RLock()

def daily_on(): return bool(cfg().get("feature_daily", True))
def daily_today(): return datetime.utcnow().date()
def daily_number(day): return (day - DAILY_EPOCH).days + 1

def _kv_get(key):
    with _db_lock: row = db().execute("SELECT value FROM kv WHERE key = ?", (key,)).fetchone()
    return row[0] if row else None

def _kv_set(key, value):
    with _db_lock: db().execute("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", (key, value))

def _title_key(title, artist):
    t = re.sub(r"[\(\[].*?[\)\]]", " ", str(title or "")).casefold()
    t = re.sub(r"\s-\s.*$", "", t)
    a = extract_primary_artist(artist).casefold()
    clean = lambda s: re.sub(r"[^\w]+", "", unicodedata.normalize("NFKD", s))
    return clean(t) + "|" + clean(a)

def daily_pick(day):
    """Today's song: the same for everyone on this server, fixed once chosen."""
    key = "daily:" + day.isoformat()
    with _daily_lock:
        got = _kv_get(key)
        if got: return json.loads(got)
        with library_cache_lock:
            every = {rel: m for rel, m in library_cache_data.items() if isinstance(m, dict)}
        songs = {rel: m for rel, m in every.items() if float(m.get("duration") or 0) >= 45}
        if len(songs) < 5: songs = every          # a small library: any song will do
        if not songs: return None
        with _db_lock:
            recent = {json.loads(v).get("rel") for (v,) in db().execute("SELECT value FROM kv WHERE key LIKE 'daily:%' AND key >= ?",
                                                                            ("daily:" + (day - timedelta(days=120)).isoformat(),))}
            popular = db().execute("SELECT rel, SUM(n), COUNT(DISTINCT user) FROM plays WHERE ts > ? GROUP BY rel",
                                   (time.time() - 365 * 86400,)).fetchall()
        # Songs people here know: played by several listeners or often, then a sprinkle of the rest of the library.
        weights = {rel: 1.0 + min(n, 50) / 5 + (users - 1) * 4 for rel, n, users in popular if rel in songs and rel not in recent}
        rng = random.Random(hashlib.sha256(f"{app.secret_key}|daily|{day.isoformat()}".encode()).digest())
        pool = list(weights) if len(weights) >= 20 else [r for r in songs if r not in recent] or list(songs)
        w = [weights.get(r, 1.0) * (1.5 if songs[r].get("has_cover") else 1) for r in pool]
        rel = rng.choices(pool, weights=w, k=1)[0]
        m = songs[rel]
        pick = {"rel": rel, "title": m.get("title") or Path(rel).stem, "artist": m.get("artist") or "", "album": m.get("album") or "",
                "key": _title_key(m.get("title") or Path(rel).stem, m.get("artist"))}
        _kv_set(key, json.dumps(pick))
        return pick

def daily_clips(day, pick):
    """Cut the six clips (once per day). Returns their folder, or None while that isn't possible."""
    d = DAILY_DIR / day.isoformat()
    if all((d / f"{i}.mp3").is_file() for i in range(len(DAILY_STAGES))): return d
    with _daily_lock:
        if all((d / f"{i}.mp3").is_file() for i in range(len(DAILY_STAGES))): return d
        path = resolve_safe_music_file(pick["rel"])
        if not path or not path.is_file(): return None
        a, _ = analysis_cached(pick["rel"])
        if not a:
            try: a = measure_song(path)
            except Exception: a = None
        # Start where the song reaches its full level, so the first second is the song and not a fade-in.
        start = max(0.0, float((a or {}).get("intro") or (a or {}).get("start") or 0) - 0.1)
        d.mkdir(parents=True, exist_ok=True)
        for i, secs in enumerate(DAILY_STAGES):
            out = d / f"{i}.mp3"
            cmd = ["nice", "-n", "10", "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-ss", f"{start:.2f}", "-t", str(secs),
                   "-i", str(path), "-map", "0:a:0", "-map_metadata", "-1", "-vn", "-ac", "2", "-ar", "44100",
                   "-af", f"afade=t=out:st={max(0, secs - .25):.2f}:d=0.25", "-c:a", "libmp3lame", "-b:a", "160k", str(out) + ".tmp.mp3"]
            if subprocess.run(cmd, capture_output=True, timeout=120).returncode != 0: return None
            os.replace(str(out) + ".tmp.mp3", out)
        return d

def daily_loop():
    """Have today's and tomorrow's songs ready ahead of time, and tidy old clips."""
    time.sleep(20)
    while True:
        try:
            if daily_on():
                for day in (daily_today(), daily_today() + timedelta(days=1)):
                    pick = daily_pick(day)
                    if pick: daily_clips(day, pick)
                if DAILY_DIR.is_dir():
                    for old in DAILY_DIR.iterdir():
                        if old.is_dir() and old.name < (daily_today() - timedelta(days=2)).isoformat(): shutil.rmtree(old, ignore_errors=True)
        except Exception as ex:
            print(f"[WARN] Axdio Daily: {ex}")
        time.sleep(600)

def _daily_row(u, day):
    with _db_lock: row = db().execute("SELECT tries, done, solved FROM daily WHERE user = ? AND day = ?", (u, day.isoformat())).fetchone()
    return {"tries": json.loads(row[0]), "done": bool(row[1]), "solved": bool(row[2])} if row else {"tries": [], "done": False, "solved": False}

def daily_stats(u):
    with _db_lock: rows = db().execute("SELECT day, solved, n FROM daily WHERE user = ? AND done = 1 ORDER BY day", (u,)).fetchall()
    dist, streak, best, prev = [0] * len(DAILY_STAGES), 0, 0, None
    for day, solved, n in rows:
        d = datetime.fromisoformat(day).date()
        if solved:
            dist[max(0, min(len(DAILY_STAGES), n) - 1)] += 1
            streak = streak + 1 if prev and (d - prev).days == 1 else 1
        else: streak = 0
        best, prev = max(best, streak), d
    today = daily_today()
    if prev and (today - prev).days > 1: streak = 0          # a missed day ends the streak
    return {"played": len(rows), "wins": sum(1 for r in rows if r[1]), "streak": streak, "best": best, "dist": dist}

def daily_view(u):
    day = daily_today()
    pick = daily_pick(day)
    if not pick: return {"empty": True}
    st = _daily_row(u, day)
    ready = daily_clips(day, pick) is not None
    out = {"number": daily_number(day), "day": day.isoformat(), "stages": DAILY_STAGES, "ready": ready, **st,
           "stage": min(len(st["tries"]), len(DAILY_STAGES) - 1), "stats": daily_stats(u),
           "next_in": int((datetime.combine(day + timedelta(days=1), datetime.min.time()) - datetime.utcnow()).total_seconds())}
    if st["done"]:
        out["answer"] = {k: pick[k] for k in ("rel", "title", "artist", "album")}
    with users_lock:
        friends = [f for f in social_rec(users_data[u])["friends"] if f in users_data]
        cards = {f: user_card(f) for f in friends}
    if friends:
        marks = ",".join("?" * len(friends))
        with _db_lock:
            rows = db().execute(f"SELECT user, tries, done, solved FROM daily WHERE day = ? AND user IN ({marks})", [day.isoformat()] + friends).fetchall()
        out["friends"] = [dict(cards[f], n=len(json.loads(t)), done=bool(dn), solved=bool(sv),
                               grid=[x.get("r") for x in json.loads(t)]) for f, t, dn, sv in rows]
    return out

@app.route("/api/daily")
def api_daily():
    return jsonify(daily_view(_me()))

@app.route("/api/daily/clip")
def api_daily_clip():
    u = _me()
    day, stage = daily_today(), request.args.get("stage", 0, type=int)
    if not 0 <= stage < len(DAILY_STAGES): abort(404)
    st = _daily_row(u, day)
    if not st["done"] and stage > len(st["tries"]): return jsonify({"error": "Guess or skip to hear more."}), 403
    pick = daily_pick(day)
    d = daily_clips(day, pick) if pick else None
    if not d: return jsonify({"error": "Today's song isn't ready yet."}), 503
    r = send_file(str(d / f"{stage}.mp3"), mimetype="audio/mpeg", conditional=True)
    r.headers["Cache-Control"] = "private, max-age=3600"
    return r

@app.route("/api/daily/guess", methods=["POST"])
def api_daily_guess():
    u = _me()
    d = _json()
    day = daily_today()
    pick = daily_pick(day)
    if not pick: return jsonify({"error": "There's no song today."}), 404
    with _daily_lock:
        st = _daily_row(u, day)
        if st["done"]: return jsonify(daily_view(u))
        if d.get("skip"):
            st["tries"].append({"r": "skip"})
        else:
            rel = str(d.get("rel") or "")
            meta = library_entry(rel)
            if not isinstance(meta, dict): return jsonify({"error": "Pick a song from the list."}), 400
            right = rel == pick["rel"] or _title_key(meta.get("title") or Path(rel).stem, meta.get("artist")) == pick["key"]
            st["tries"].append({"r": "right" if right else "wrong", "t": (meta.get("title") or Path(rel).stem)[:120],
                                "a": (meta.get("artist") or "")[:120]})
            if right: st["solved"] = True
        st["done"] = st["solved"] or len(st["tries"]) >= len(DAILY_STAGES)
        with _db_lock:
            db().execute("INSERT OR REPLACE INTO daily (user, day, tries, done, solved, n) VALUES (?, ?, ?, ?, ?, ?)",
                         (u, day.isoformat(), json.dumps(st["tries"]), int(st["done"]), int(st["solved"]), len(st["tries"])))
    if st["done"]:
        with users_lock: friends = list(social_rec(users_data[u])["friends"])
        bump(friends, "f")
    return jsonify(daily_view(u))

# ============================================================
# DISCOVER: a feed of songs you've never played
# ============================================================
# One swipe per song: each starts at its hook (the loudest 15 seconds, from Smart transitions' measurements). Picks mix
# what friends have on repeat (only friends who share their listening), more from artists you love, and deep cuts.
_disc_shown = {}            # username -> songs shown lately, so the feed doesn't repeat itself

def events_add(u, kind, ref=""):
    with _db_lock: db().execute("INSERT INTO events (user, ts, kind, ref) VALUES (?, ?, ?, ?)", (u, time.time(), kind, str(ref)[:1000]))

def analysis_enqueue(rel):
    with _an_lock:
        if rel in _an_waiting or len(_an_queue) >= 40: return
        _an_waiting.add(rel); _an_queue.append(rel); _an_wake.set()

def discover_on(): return bool(cfg().get("feature_discover", True))

@app.route("/api/discover")
def api_discover():
    u = _me()
    n = max(1, min(30, request.args.get("n", 12, type=int)))
    with users_lock:
        rec = users_data[u]
        friends = [f for f in social_rec(rec)["friends"] if f in users_data and social_rec(users_data[f])["share_activity"]]
        names = {f: user_card(f)["display_name"] for f in friends}
        likes = [x for x in rec.get("liked_songs") or [] if isinstance(x, str)]
        known = {h.get("rel_path") for h in rec.get("history") or []} | set(likes)
    with library_cache_lock:
        every = {r: m for r, m in library_cache_data.items() if isinstance(m, dict) and not FED_REMOTE_RE.match(r)}
    lib = {r: m for r, m in every.items() if float(m.get("duration") or 0) >= 30}
    if len(lib) < 10: lib = every
    artist = lambda m: extract_primary_artist(m.get("artist"), m.get("album_artist"))
    fav = Counter()
    for r in likes:
        if r in every: fav[artist(every[r])] += 3
    with _db_lock:
        mine = db().execute("SELECT rel, SUM(n) FROM plays WHERE user = ? GROUP BY rel", (u,)).fetchall()
        hot = []
        if friends:
            marks = ",".join("?" * len(friends))
            hot = db().execute(f"SELECT user, rel, SUM(n) s FROM plays WHERE user IN ({marks}) AND b = 0 AND ts > ? GROUP BY user, rel HAVING s >= 3",
                               friends + [time.time() - 90 * 86400]).fetchall()
    for r, c in mine:
        known.add(r)
        if r in every: fav[artist(every[r])] += c
    fav.pop("Unknown Artist", None)
    loved = {a for a, _ in fav.most_common(25)}
    by_friend = {}
    for f, r, c in hot:
        if r not in by_friend or c > by_friend[r][1]: by_friend[r] = (f, c)
    shown = _disc_shown.setdefault(u, collections.deque(maxlen=800))
    seen = set(shown)
    pool = [r for r in lib if r not in known and r not in seen]
    if len(pool) < n:           # heard or seen everything: go round again
        shown.clear()
        pool = [r for r in lib if r not in known] or list(lib)
    rng, scored = random.Random(), []
    for r in pool:
        a = artist(lib[r])
        if r in by_friend: w, why = 6.0, {"kind": "friend", "text": f"{names[by_friend[r][0]]} has it on repeat", "user": by_friend[r][0]}
        elif a in loved: w, why = 4.0, {"kind": "artist", "text": f"More from {a}"}
        else: w, why = 1.0, {"kind": "new", "text": "Something new for you"}
        scored.append((rng.random() ** (1 / w), r, a, why))     # a weighted draw without replacement
    scored.sort(reverse=True)
    out, per_artist = [], Counter()
    for _, r, a, why in scored:
        if per_artist[a] >= 2: continue
        per_artist[a] += 1
        m, (an, _) = lib[r], analysis_cached(r)
        dur = float(m.get("duration") or (an or {}).get("dur") or 0)
        hook = (an or {}).get("hook")
        if hook is None: analysis_enqueue(r)
        out.append({"rel": r, "title": m.get("title") or Path(r).stem, "artist": m.get("artist") or "", "album": m.get("album") or "",
                    "dur": dur, "hook": hook if hook is not None else round(dur * .33, 1), "why": why})
        shown.append(r)
        if len(out) >= n: break
    return jsonify({"items": out})

@app.route("/api/discover/log", methods=["POST"])
def api_discover_log():
    """What a listener did with a Discover pick (for their own stats and achievements)."""
    u = _me()
    d = _json()
    if d.get("action") not in ("like", "queue", "full"): return jsonify({"error": "Unknown action."}), 400
    if not rate_ok(("disc", u), 300, 3600): return jsonify({"ok": True})
    events_add(u, "discover_" + d["action"], d.get("rel") or "")
    return jsonify({"ok": True})

# ============================================================
# LEVELS, STREAKS AND ACHIEVEMENTS
# ============================================================
# Worked out from what's already here (the listening log, Daily results, Discover likes, friends, likes and parties), so
# there's nothing extra to store. XP: one point per minute listened, plus bonuses for Daily wins and Discover finds.
# A listener sees all of theirs; friends see the level, streak and best badges, and only when activity is shared.
BADGES = [  # id, name, icon, what it counts, bronze / silver / gold
    ("night_owl", "Night Owl", "moon", "Songs played between midnight and 5 am", (10, 50, 200)),
    ("early_bird", "Early Bird", "spark", "Songs played between 5 and 8 am", (10, 50, 200)),
    ("explorer", "Explorer", "compass", "Different artists played", (25, 100, 300)),
    ("devoted", "Devoted", "note", "Plays of your favourite artist", (50, 250, 1000)),
    ("on_repeat", "On Repeat", "repeat", "Plays of one song in a single day", (5, 10, 25)),
    ("marathon", "Marathon", "timer", "Minutes listened in one day", (120, 240, 480)),
    ("streaker", "Unstoppable", "flame", "Days in a row with music (best streak)", (7, 30, 100)),
    ("album_purist", "Album Purist", "album", "Albums played from start to finish (every track)", (1, 10, 50)),
    ("collector", "Collector", "heart", "Liked songs", (50, 250, 1000)),
    ("crate_digger", "Crate Digger", "compass", "Songs liked from Discover", (5, 25, 100)),
    ("tune_master", "Name That Tune", "trophy", "Axdio Daily wins", (5, 25, 100)),
    ("perfect_pitch", "Perfect Pitch", "trophy", "Axdio Daily solved from one second", (1, 5, 20)),
    ("daily_streak", "Daily Devotee", "flame", "Axdio Daily wins in a row (best)", (3, 10, 30)),
    ("social", "Social Butterfly", "people", "Friends", (3, 10, 25)),
    ("party", "Party Starter", "party", "Listening parties hosted or joined", (1, 10, 50)),
]
_ach_cache = {}
_album_map = {"t": 0, "albums": []}

def xp_level(xp):
    """Level n needs 60·(n-1)^1.5 XP in total: an hour a day gets you to level 10 in about a month."""
    lvl = 1
    while 60 * lvl ** 1.5 <= xp: lvl += 1
    return lvl, int(60 * (lvl - 1) ** 1.5), int(60 * lvl ** 1.5)

def _albums():
    if time.time() - _album_map["t"] > 600:
        groups = collections.defaultdict(set)
        with library_cache_lock:
            for rel, m in library_cache_data.items():
                if isinstance(m, dict) and m.get("album"): groups[(m["album"], m.get("album_artist") or m.get("artist") or "")].add(rel)
        _album_map.update(t=time.time(), albums=[s for s in groups.values() if len(s) >= 4])
    return _album_map["albums"]

def achievements(u, tz=0):
    key = (u, tz)
    hit = _ach_cache.get(key)
    if hit and time.time() - hit[0] < 60: return hit[1]
    local = lambda ts: datetime.utcfromtimestamp(ts - tz * 60)
    with _db_lock:
        conn = db()
        plays = conn.execute("SELECT ts, rel, secs, n, b FROM plays WHERE user = ?", (u,)).fetchall()
        daily_rows = conn.execute("SELECT day, solved, n FROM daily WHERE user = ? AND done = 1 ORDER BY day", (u,)).fetchall()
        ev = dict(conn.execute("SELECT kind, COUNT(*) FROM events WHERE user = ? GROUP BY kind", (u,)).fetchall())
    with users_lock:
        rec = users_data.get(u) or {}
        friends = len(social_rec(rec)["friends"])
        liked = len([x for x in rec.get("liked_songs") or [] if isinstance(x, str)])
    minutes, night, early, artists, per_artist = 0.0, 0, 0, set(), Counter()
    day_mins, day_song, days, played = Counter(), Counter(), set(), set()
    for ts, rel, secs, n, b in plays:
        minutes += secs * n / 60
        played.add(rel)
        meta = library_entry(rel)
        if isinstance(meta, dict):
            a = extract_primary_artist(meta.get("artist"), meta.get("album_artist"))
            if a != "Unknown Artist": artists.add(a); per_artist[a] += n
        if b: continue
        d = local(ts)
        if d.hour < 5: night += n
        elif d.hour < 8: early += n
        day_mins[d.date()] += secs * n / 60
        day_song[(d.date(), rel)] += n
        days.add(d.date())
    today = local(time.time()).date()
    streak, best, run, prev = 0, 0, 0, None
    for d in sorted(days):
        run = run + 1 if prev and (d - prev).days == 1 else 1
        best, prev = max(best, run), d
    if prev and (today - prev).days <= 1: streak = run
    wins = sum(1 for r in daily_rows if r[1])
    firsts = sum(1 for r in daily_rows if r[1] and r[2] == 1)
    dbest = drun = 0; dprev = None
    for day, solved, n in daily_rows:
        dd = datetime.fromisoformat(day).date()
        drun = drun + 1 if solved and dprev and (dd - dprev).days == 1 and drun else (1 if solved else 0)
        dbest, dprev = max(dbest, drun), dd
    albums_done = sum(1 for s in _albums() if s <= played)
    values = {"night_owl": night, "early_bird": early, "explorer": len(artists), "devoted": max(per_artist.values(), default=0),
              "on_repeat": max(day_song.values(), default=0), "marathon": round(max(day_mins.values(), default=0)), "streaker": best,
              "album_purist": albums_done, "collector": liked, "crate_digger": ev.get("discover_like", 0), "tune_master": wins,
              "perfect_pitch": firsts, "daily_streak": dbest, "social": friends, "party": ev.get("party_host", 0) + ev.get("party_join", 0)}
    badges = []
    for bid, name, icon, what, tiers in BADGES:
        v = values[bid]
        tier = sum(1 for t in tiers if v >= t)
        badges.append({"id": bid, "name": name, "icon": icon, "what": what, "value": v, "tier": tier,
                       "next": tiers[tier] if tier < 3 else None, "prev": tiers[tier - 1] if tier else 0})
    xp = int(minutes) + wins * 25 + firsts * 50 + ev.get("discover_like", 0) * 10 + ev.get("party_host", 0) * 30
    lvl, lo, hi = xp_level(xp)
    out = {"xp": xp, "level": lvl, "level_from": lo, "level_to": hi, "streak": streak, "best_streak": best,
           "played_today": today in days, "minutes": round(minutes), "badges": badges}
    _ach_cache[key] = (time.time(), out)
    return out

def achievements_public(u):
    """What friends see: level, streak and the best badges."""
    a = achievements(u)
    top = sorted([b for b in a["badges"] if b["tier"]], key=lambda b: (-b["tier"], -b["value"]))[:4]
    return {"level": a["level"], "streak": a["streak"], "badges": [{k: b[k] for k in ("id", "name", "icon", "tier")} for b in top]}

def achievements_on(): return bool(cfg().get("feature_achievements", True))

@app.route("/api/achievements")
def api_achievements():
    u = _me()
    return jsonify(achievements(u, max(-900, min(900, request.args.get("tz", 0, type=int)))))

# ============================================================
# FRIENDS CHART AND TIME CAPSULE
# ============================================================
# The chart: the week's most played songs among a listener and their friends who share their listening, with where each
# song was the week before. The time capsule: what a listener played on this day in earlier years (or a month ago), and
# favourites they haven't played in a while. Both only ever read the listening log of people who share it.
def chart_on(): return social_on() and bool(cfg().get("feature_chart", True))
def capsule_on(): return bool(cfg().get("feature_capsule", True))

def _song(rel, **extra):
    m = library_entry(rel) or {}
    return dict(rel=rel, title=m.get("title") or Path(rel).stem, artist=m.get("artist") or "", **extra)

def _chart(people, start, end):
    marks = ",".join("?" * len(people))
    with _db_lock:
        rows = db().execute(f"SELECT user, rel, SUM(n) FROM plays WHERE b = 0 AND ts >= ? AND ts < ? AND user IN ({marks}) GROUP BY user, rel",
                            [start, end] + people).fetchall()
    per = {}
    for user, rel, n in rows:
        if not isinstance(library_entry(rel), dict): continue
        e = per.setdefault(rel, {"plays": 0, "users": {}})
        e["plays"] += n
        e["users"][user] = e["users"].get(user, 0) + n
    # Songs several people play rank above one person's loop.
    return sorted(per.items(), key=lambda kv: -(kv[1]["plays"] * (1 + .6 * (len(kv[1]["users"]) - 1))))

@app.route("/api/social/chart")
def social_chart():
    u = _me()
    if not chart_on(): return jsonify({"off": True, "items": []})
    with users_lock:
        friends = [f for f in social_rec(users_data[u])["friends"]
                   if f in users_data and social_rec(users_data[f])["share_activity"] and not blocked_either(u, f)]
        people = [u] + friends
        cards = {p: user_card(p) for p in people}
    now, week = time.time(), 7 * 86400
    before = {rel: i + 1 for i, (rel, _) in enumerate(_chart(people, now - 2 * week, now - week)[:100])}
    items = []
    for i, (rel, e) in enumerate(_chart(people, now - week, now)[:20]):
        who = sorted(e["users"], key=lambda x: -e["users"][x])
        items.append(_song(rel, rank=i + 1, prev=before.get(rel), plays=e["plays"], listeners=[cards[x] for x in who[:5]], n_listeners=len(who)))
    return jsonify({"items": items, "friends": len(friends), "from": now - week, "to": now})

@app.route("/api/timecapsule")
def api_timecapsule():
    u = _me()
    if not capsule_on(): return jsonify({"off": True})
    tz = max(-900, min(900, request.args.get("tz", 0, type=int)))
    local = lambda ts: datetime.utcfromtimestamp(ts - tz * 60)
    today = local(time.time()).date()
    last_month = today.replace(day=1) - timedelta(days=1)
    month_ago = last_month.replace(day=min(today.day, last_month.day))
    with _db_lock: rows = db().execute("SELECT ts, rel, n FROM plays WHERE user = ?", (u,)).fetchall()
    years, month, totals, last = collections.defaultdict(Counter), Counter(), Counter(), {}
    for ts, rel, n in rows:
        totals[rel] += n
        last[rel] = max(last.get(rel, 0), ts)
        d = local(ts).date()
        if (d.month, d.day) == (today.month, today.day) and d.year < today.year: years[d.year][rel] += n
        elif d == month_ago: month[rel] += n
    keep = lambda c: [r for r, _ in c.most_common() if isinstance(library_entry(r), dict)]
    out = {"today": today.isoformat(),
           "years": [{"year": y, "ago": today.year - y, "songs": [_song(r) for r in keep(years[y])[:12]]} for y in sorted(years, reverse=True)],
           "month": {"date": month_ago.isoformat(), "songs": [_song(r) for r in keep(month)[:12]]} if month else None,
           "rediscover": [_song(r, plays=totals[r]) for r in keep(totals) if totals[r] >= 4 and time.time() - last[r] > 45 * 86400][:40]}
    out["years"] = [y for y in out["years"] if y["songs"]]
    return jsonify(out)

# --- Startup ---
load_users()
load_plugins()
threading.Thread(target=library_scanner, daemon=True, name="library-scanner").start()
threading.Thread(target=backfill_durations, daemon=True, name="duration-backfill").start()
threading.Thread(target=backup_scheduler, daemon=True, name="backup-scheduler").start()
threading.Thread(target=duration_flusher, daemon=True, name="duration-flusher").start()
threading.Thread(target=social_janitor, daemon=True, name="social-janitor").start()
threading.Thread(target=chat_expiry, daemon=True, name="chat-expiry").start()
threading.Thread(target=analysis_worker, daemon=True, name="song-analysis").start()
threading.Thread(target=rewind_backfill, daemon=True, name="rewind-backfill").start()
threading.Thread(target=daily_loop, daemon=True, name="daily").start()
threading.Thread(target=fed_sync_loop, daemon=True, name="library-sharing").start()
threading.Thread(target=plugins_loop, daemon=True, name="plugins").start()
threading.Thread(target=updates_loop, daemon=True, name="updates").start()
if (CONFIG_DIR / "python-packages").is_dir():
    print("[INFO] config/python-packages isn't used any more (plugins live in config/plugins). You can delete that folder.")
rebuild_in_memory_tree()   # again, now that music shared by other servers can be added
cfg()
activity("server", f"Server started (v{AXDIO_VERSION})", None)
notify("server_started", "Server started", f"{cfg().get('site_title', 'Axdio')} is up.")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=config.get("port", 7865), debug=False, threaded=True)
