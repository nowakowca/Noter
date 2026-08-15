'use strict';

// When started as root — the Docker entrypoint fixes directory ownership and
// then execs us as root — drop to PUID:PGID before anything opens a file, so the
// database and downloaded media are owned by that user. No-op when not running
// as root (e.g. local `npm start`), so it's harmless outside Docker.
//
// Doing this in-process avoids needing an external tool like gosu/su-exec (and
// the extra apt install that came with it).
if (typeof process.getuid === 'function' && process.getuid() === 0) {
  const uid = parseInt(process.env.PUID || '1000', 10) || 1000;
  const gid = parseInt(process.env.PGID || '1000', 10) || 1000;
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
