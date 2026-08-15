'use strict';

// When started as root — the Docker entrypoint fixes directory ownership and
// then execs us as root — drop to PUID:PGID before anything opens a file, so the
// database and downloaded media are owned by that user. No-op when not running
// as root (e.g. local `npm start`), so it's harmless outside Docker.
//
// Doing this in-process avoids needing an external tool like gosu/su-exec (and
// the extra apt install that came with it).
if (typeof process.getuid === 'function' && process.getuid() === 0) {
  // Note: don't use `|| 1000` — it would turn a valid PUID=0 into 1000.
  let uid = parseInt(process.env.PUID, 10);
  let gid = parseInt(process.env.PGID, 10);
  if (Number.isNaN(uid)) uid = 1000;
  if (Number.isNaN(gid)) gid = 1000;

  if (uid === 0 && gid === 0) return; // explicitly asked to stay root

  try {
    if (typeof process.setgroups === 'function') process.setgroups([]);
    process.setgid(gid);
    process.setuid(uid);
    if (!process.env.HOME || process.env.HOME === '/root') {
      process.env.HOME = '/tmp'; // Chromium (Instagram backup) needs a writable HOME
    }
    console.log(`Dropped privileges to ${uid}:${gid}`);
  } catch (err) {
    console.error('Could not drop privileges:', err.message);
    process.exit(1);
  }
}

module.exports = {};
