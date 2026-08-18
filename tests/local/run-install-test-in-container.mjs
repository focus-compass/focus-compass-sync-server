#!/usr/bin/env node
/**
 * Cross-platform launcher for the curl|bash installer E2E.
 *
 * Windows PowerShell / npm scripts resolve `bash` to WSL (the Podman
 * machine), which cannot see the Windows working directory. This launcher
 * talks to podman.exe / docker.exe directly.
 *
 *   node tests/local/run-install-test-in-container.mjs
 *   node tests/local/run-install-test-in-container.mjs --local ../focus-compass-app/public/install-sync-server.sh
 *   node tests/local/run-install-test-in-container.mjs --rebuild
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '../..');
const imageName = process.env.INSTALLER_E2E_IMAGE || 'localhost/focus-compass-installer-e2e:2';
const containerfile = path.join(here, 'Containerfile');
const hostWorkDir = '/var/tmp/fc-installer-e2e';
const firewallDropIn = '~/.config/containers/containers.conf.d/99-fc-installer-e2e.conf';
const reservedContainers = ['focus-compass-sync-server', 'focus-compass-caddy'];
const reservedVolumes = [
  'focus_compass_sync_server_hocuspocus-data',
  'focus_compass_sync_server_caddy-data',
  'focus_compass_sync_server_caddy-config',
];
const reservedNetworks = ['focus_compass_sync_server_default'];

function parseArgs(argv) {
  const options = { localInstaller: '', rebuild: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--local') {
      i += 1;
      if (i >= argv.length) {
        throw new Error('--local requires a path to install-sync-server.sh');
      }
      options.localInstaller = path.resolve(argv[i]);
    } else if (arg === '--rebuild') {
      options.rebuild = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log('See file header for usage.');
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function enginePath(bin) {
  if (process.platform !== 'win32') return bin;
  if (bin.endsWith('.exe')) return bin;
  return `${bin}.exe`;
}

function findEngine() {
  const requested = process.env.CONTAINER_BIN;
  const candidates = requested
    ? [requested]
    : ['podman', 'docker'];

  for (const bin of candidates) {
    const exe = enginePath(bin);
    const probe = spawnSync(exe, ['info'], { stdio: 'ignore', windowsHide: true });
    if (!probe.error && probe.status === 0) {
      return exe;
    }
  }

  throw new Error(
    requested
      ? `CONTAINER_BIN=${requested} is not reachable.`
      : 'Neither podman nor docker is reachable.',
  );
}

function toMountPath(absPath) {
  return path.resolve(absPath).replace(/\\/g, '/');
}

function hostDockerSocket(engine) {
  if (process.env.DOCKER_HOST_SOCKET) {
    return process.env.DOCKER_HOST_SOCKET;
  }

  const engineName = path.basename(engine).toLowerCase();
  if (engineName.startsWith('podman')) {
    const info = spawnSync(engine, ['info', '--format', '{{.Host.RemoteSocket.Path}}'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const raw = (info.stdout || '').trim();
    const socket = raw.replace(/^unix:\/\//, '');
    if (socket.startsWith('/')) {
      return socket;
    }
    return '/run/user/1000/podman/podman.sock';
  }

  return '/var/run/docker.sock';
}

function run(bin, args, options = {}) {
  const result = spawnSync(bin, args, {
    stdio: 'inherit',
    windowsHide: true,
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

function capture(bin, args) {
  return spawnSync(bin, args, {
    encoding: 'utf8',
    windowsHide: true,
  });
}

function machineSsh(engine, remoteCommand) {
  return capture(engine, ['machine', 'ssh', remoteCommand]);
}

function listNames(engine, kind) {
  const args = kind === 'network'
    ? ['network', 'ls', '--format', '{{.Name}}']
    : ['ps', '-a', '--format', '{{.Names}}'];
  const listed = capture(engine, args);
  return (listed.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function removeQuiet(engine, args) {
  spawnSync(engine, args, { stdio: 'ignore', windowsHide: true });
}

function cleanupLeftoverInstallerResources(engine) {
  for (const name of reservedContainers) {
    removeQuiet(engine, ['rm', '-f', name]);
  }
  for (const name of listNames(engine, 'container')) {
    if (
      name.startsWith('fc-existing-proxy-')
      || name.startsWith('fc-nft-repro')
      || name.startsWith('fc-e2e-net-probe')
    ) {
      removeQuiet(engine, ['rm', '-f', name]);
    }
  }
  for (const name of reservedVolumes) {
    removeQuiet(engine, ['volume', 'rm', '-f', name]);
  }
  for (const name of reservedNetworks) {
    removeQuiet(engine, ['network', 'rm', name]);
  }
  for (const name of listNames(engine, 'network')) {
    if (name.startsWith('fc-nft-repro') || name.startsWith('fc-e2e-net-probe')) {
      removeQuiet(engine, ['network', 'rm', name]);
    }
  }
}

function ensureWorkDir(engine) {
  const result = machineSsh(
    engine,
    `sudo -n mkdir -p ${hostWorkDir} && sudo -n chmod 777 ${hostWorkDir} && rm -rf ${hostWorkDir}/./* ${hostWorkDir}/.[!.]* 2>/dev/null; mkdir -p ${hostWorkDir} && chmod 777 ${hostWorkDir}`,
  );
  if (result.status !== 0) {
    throw new Error(`could not prepare ${hostWorkDir} in the Podman machine`);
  }
}

function customNetworkPublishWorks(engine) {
  const net = `fc-e2e-net-probe-${process.pid}`;
  const container = `fc-e2e-net-probe-${process.pid}`;
  const port = 18198;
  try {
    removeQuiet(engine, ['rm', '-f', container]);
    removeQuiet(engine, ['network', 'rm', net]);
    const created = capture(engine, ['network', 'create', net]);
    if (created.status !== 0) return false;
    const probed = capture(engine, [
      'run',
      '--rm',
      '--name',
      container,
      '--network',
      net,
      '-p',
      `127.0.0.1:${port}:80`,
      '--entrypoint',
      '/bin/true',
      'docker.io/library/nginx:1.27.5-alpine',
    ]);
    return probed.status === 0;
  } finally {
    removeQuiet(engine, ['rm', '-f', container]);
    removeQuiet(engine, ['network', 'rm', net]);
  }
}

function ensureRootlessCustomNetworks(engine) {
  const written = machineSsh(
    engine,
    `mkdir -p ~/.config/containers/containers.conf.d && printf '%s\\n' '[network]' 'firewall_driver = "none"' > ${firewallDropIn}`,
  );
  if (written.status !== 0) {
    console.warn('[warn] could not write rootless firewall drop-in; compose publish may fail');
    if (written.stderr) process.stderr.write(written.stderr);
    return;
  }
  console.log(`Rootless netavark: ${firewallDropIn} -> firewall_driver=none`);

  if (customNetworkPublishWorks(engine)) {
    console.log('Custom-network loopback publish works.');
    return;
  }

  console.log('Custom-network publish still blocked; restarting user podman.service (containers stay up).');
  const restarted = machineSsh(engine, 'systemctl --user restart podman.service');
  if (restarted.status !== 0) {
    console.warn('[warn] could not restart podman.service');
    if (restarted.stderr) process.stderr.write(restarted.stderr);
    return;
  }

  let ready = false;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const info = capture(engine, ['info']);
    if (info.status === 0) {
      ready = true;
      break;
    }
    machineSsh(engine, 'sleep 0.5');
  }
  if (!ready) {
    console.warn('[warn] podman API did not come back after service restart');
    return;
  }

  if (customNetworkPublishWorks(engine)) {
    console.log('Custom-network loopback publish works after API restart.');
    return;
  }
  console.warn('[warn] custom-network publish still fails; installer compose up may hit netavark/nftables');
}

function imageExists(engine) {
  const result = spawnSync(engine, ['image', 'exists', imageName], {
    stdio: 'ignore',
    windowsHide: true,
  });
  if (!result.error && result.status === 0) return true;

  const listed = spawnSync(engine, ['images', '-q', imageName], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return !listed.error && Boolean(listed.stdout && listed.stdout.trim());
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.localInstaller && !existsSync(options.localInstaller)) {
    throw new Error(`No such file: ${options.localInstaller}`);
  }
  if (!existsSync(containerfile)) {
    throw new Error(`Missing Containerfile: ${containerfile}`);
  }

  const engine = findEngine();
  console.log(`Engine: ${engine}`);

  if (options.rebuild || !imageExists(engine)) {
    console.log(`Building ${imageName} (first run installs Docker + Node; this takes a few minutes).`);
    const buildStatus = run(engine, [
      'build',
      '-t',
      imageName,
      '-f',
      toMountPath(containerfile),
      // Context is tests/ so the production .dockerignore (which excludes
      // tests/) cannot hide e2e-client.mjs.
      toMountPath(path.join(serverRoot, 'tests')),
    ]);
    if (buildStatus !== 0) {
      process.exit(buildStatus);
    }
  } else {
    console.log(`Using cached image ${imageName} (pass --rebuild to refresh).`);
  }

  const dockerSocket = hostDockerSocket(engine);
  const engineName = path.basename(engine).toLowerCase();
  if (engineName.startsWith('podman')) {
    // Rootless Podman cannot publish 80/443 unless the VM allows
    // unprivileged low ports. Passwordless sudo is the machine default.
    const sysctl = machineSsh(engine, 'sudo -n sysctl -w net.ipv4.ip_unprivileged_port_start=80');
    if (sysctl.status !== 0) {
      console.warn('[warn] could not lower unprivileged port start; binding :80/:443 may fail');
      if (sysctl.stderr) process.stderr.write(sysctl.stderr);
    } else if (sysctl.stdout) {
      process.stdout.write(sysctl.stdout);
    }
    // Compose creates a custom network and publishes 127.0.0.1:PORT.
    // Rootless netavark+nftables cannot apply that ruleset; disable the
    // firewall driver instead of changing the installer compose contract.
    ensureRootlessCustomNetworks(engine);
    ensureWorkDir(engine);
    cleanupLeftoverInstallerResources(engine);
    const postgres = capture(engine, ['ps', '--filter', 'name=local-postgres', '--format', '{{.Names}} {{.Status}}']);
    if (postgres.stdout && postgres.stdout.trim()) {
      console.log(`Left running: ${postgres.stdout.trim()}`);
    }
  }

  const runArgs = [
    'run',
    '--rm',
    '--network=host',
    '--security-opt',
    'label=disable',
    '-v',
    `${dockerSocket}:/var/run/docker.sock`,
    '-v',
    `${hostWorkDir}:${hostWorkDir}`,
    '-v',
    `${toMountPath(serverRoot)}:/repo:ro`,
    '-e',
    `KEEP=${process.env.KEEP || '0'}`,
    '-e',
    'E2E_ROOT=/opt/fc-e2e',
    '-e',
    'DOCKER_HOST=unix:///var/run/docker.sock',
    '-e',
    `HOME=${hostWorkDir}`,
    '-e',
    `TMPDIR=${hostWorkDir}`,
    '-e',
    `INSTALL_DIR=${hostWorkDir}/install`,
  ];

  if (options.localInstaller) {
    runArgs.push(
      '-v',
      `${toMountPath(options.localInstaller)}:/installer.sh:ro`,
      '-e',
      'INSTALLER_FILE=/installer.sh',
    );
    console.log(`Testing LOCAL installer copy: ${options.localInstaller}`);
  } else {
    const url = process.env.INSTALLER_URL || 'https://focus-compass.com/install-sync-server.sh';
    runArgs.push('-e', `INSTALLER_URL=${url}`);
    console.log(`Testing PRODUCTION installer: ${url}`);
  }

  runArgs.push(imageName, 'bash', '/repo/tests/local/container-entry.sh');
  process.exit(run(engine, runArgs));
}

try {
  main();
} catch (error) {
  console.error(`[FAIL] ${error.message}`);
  process.exit(1);
}
