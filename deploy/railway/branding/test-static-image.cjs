// Run against the built image, not an unrelated host browser. No external calls.
const assert = require('node:assert/strict');
const http = require('node:http');
const { chromium } = require('/app/core/meetings/modules/join/node_modules/playwright');
const { getJoinBrowserArgs } = require('/app/core/meetings/modules/join/dist/browser-args');
const { enableStaticImage, cameraIsOn, staticLogoBrowserArgs, isStaticLogoEnabled } = require('/app/core/meetings/modules/join/dist/shared/meetings-ai-static-image');

(async () => {
  let checks = 0;
  const check = (value, message) => { assert.ok(value, message); checks++; console.log(`PASS ${message}`); };
  check(isStaticLogoEnabled(), 'bundled image and deployment flag enable global branding');
  const before = ['--use-file-for-fake-video-capture=/dev/null', '--no-sandbox'];
  const args = staticLogoBrowserArgs(before);
  check(args.filter(arg => arg.startsWith('--use-file-for-fake-video-capture=')).length === 1, 'old empty camera source replaced exactly once');
  check(before[0].endsWith('/dev/null'), 'launch argument input is not mutated');
  process.env.MEETINGS_AI_STATIC_LOGO_ENABLED = 'false';
  assert.deepEqual(staticLogoBrowserArgs(before), before);
  check(!isStaticLogoEnabled(), 'kill switch preserves original camera behavior');
  process.env.MEETINGS_AI_STATIC_LOGO_ENABLED = 'true';
  check(cameraIsOn({ label: 'Something else', checked: null, muted: null }) === undefined, 'unknown controls are not guessed');

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><body>Meetings AI local media test</body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  // Match the bot's actual merged argument order, including the older empty
  // camera argument from remote-browser. Chromium must use the final logo path.
  const { getAuthenticatedBrowserArgs } = await import('/app/core/meetings/modules/remote-browser/dist/args.js');
  const browser = await chromium.launch({ headless: false, args: [...getAuthenticatedBrowserArgs(), ...getJoinBrowserArgs()] });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    for (const label of ['Turn on camera', 'Turn camera on', 'Start Video']) {
      await page.setContent(`<button aria-label="${label}" onclick="window.clicks++;this.setAttribute('aria-label', '${label === 'Start Video' ? 'Stop Video' : 'Turn off camera'}')">Camera</button><script>window.clicks=0;</script>`);
      check(await enableStaticImage(page, ['button'], () => {}) === 'enabled', `camera-off → static image on: ${label}`);
      check(await enableStaticImage(page, ['button'], () => {}) === 'already-on', 'already-on camera is not accidentally switched off');
      check(await page.evaluate(() => window.clicks) === 1, 'only one camera click across repeated configuration');
    }
    await page.setContent('<input type="checkbox" role="switch" aria-label="Camera"><button aria-label="Unmute microphone" onclick="window.micClicks++">Mic</button><script>window.micClicks=0;</script>');
    check(await enableStaticImage(page, ['[role="switch"]'], () => {}) === 'enabled', 'Teams checkbox-style camera switch supported');
    check(await page.evaluate(() => window.micClicks) === 0, 'camera helper never touches microphone');
    await page.setContent('<button aria-label="Turn on camera" onclick="this.setAttribute(\'aria-label\',\'Turn off camera\')">Camera</button>');
    let delegatedClicks = 0;
    check(await enableStaticImage(page, ['button'], () => {}, async handle => { delegatedClicks++; await handle.click(); }) === 'enabled' && delegatedClicks === 1,
      'Google Meet can retain its existing camera-click interaction handler');
    await page.setContent('<button aria-label="Turn on camera" disabled>Camera</button>');
    check(await enableStaticImage(page, ['button'], () => {}) === 'blocked', 'host-disabled camera respected');
    await page.setContent('<button aria-label="Camera">Camera</button>');
    check(await enableStaticImage(page, ['button'], () => {}) === 'unknown', 'unrecognized camera state leaves control unchanged');
    await page.setContent('<button aria-label="Turn on camera" onclick="window.clicks++">Camera</button><script>window.clicks=0;</script>');
    check(await enableStaticImage(page, ['button'], () => {}) === 'blocked', 'camera rejected by platform is not repeatedly forced on');
    check(await page.evaluate(() => window.clicks) === 1, 'no retry loop when platform blocks image');
    check(await enableStaticImage(page, ['.missing-camera'], () => {}, undefined, 50) === 'unavailable', 'missing camera does not fail meeting join');

    // Independent Chromium processes model a bot and a remote participant.
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const observerBrowser = await chromium.launch({ headless: false, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
    let media;
    try {
    const observerPage = await observerBrowser.newPage();
    await observerPage.goto(`http://127.0.0.1:${server.address().port}`);
    const offer = await page.evaluate(async () => {
      const camera = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 360, frameRate: 5 }, audio: false });
      const bot = window.bot = new RTCPeerConnection({ iceServers: [] });
      const audio = window.audio = new AudioContext();
      await audio.resume();
      bot.ontrack = event => {
        if (event.track.kind === 'audio') {
          // Meeting clients render remote audio too. Start Chromium's receive
          // playout pipeline before inspecting it through Web Audio.
          const received = document.createElement('audio');
          received.autoplay = true;
          received.srcObject = new MediaStream([event.track]);
          document.body.append(received);
          received.play().catch(() => {});
          const analyser = window.analyser = audio.createAnalyser();
          audio.createMediaStreamSource(new MediaStream([event.track])).connect(analyser);
          const silent = audio.createGain(); silent.gain.value = 0;
          analyser.connect(silent).connect(audio.destination);
        }
      };
      camera.getVideoTracks().forEach(track => bot.addTrack(track, camera));
      bot.addTransceiver('audio', { direction: 'recvonly' });
      await bot.setLocalDescription(await bot.createOffer());
      const deadline = Date.now() + 5000;
      while (bot.iceGatheringState !== 'complete' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      return bot.localDescription.toJSON();
    });
    const answer = await observerPage.evaluate(async offer => {
      const observer = window.observer = new RTCPeerConnection({ iceServers: [] });
      const video = document.createElement('video');
      video.id = 'remote'; video.autoplay = true; video.muted = true;
      document.body.append(video);
      observer.ontrack = event => { if (event.track.kind === 'video') video.srcObject = new MediaStream([event.track]); };
      const audio = new AudioContext();
      await audio.resume();
      const oscillator = audio.createOscillator();
      const output = audio.createMediaStreamDestination();
      oscillator.connect(output);
      oscillator.start();
      await observer.setRemoteDescription(offer);
      observer.addTrack(output.stream.getAudioTracks()[0], output.stream);
      await observer.setLocalDescription(await observer.createAnswer());
      const deadline = Date.now() + 5000;
      while (observer.iceGatheringState !== 'complete' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      return observer.localDescription.toJSON();
    }, offer);
    await page.evaluate(answer => window.bot.setRemoteDescription(answer), answer);
    await observerPage.waitForFunction(() => document.querySelector('#remote').videoWidth >= 320, undefined, { timeout: 15000 });
    const audioResult = await page.evaluate(async () => {
      const deadline = Date.now() + 10000;
      let receivedAudio = false, peak = 0;
      while (Date.now() < deadline) {
        if (window.analyser) {
          const samples = new Float32Array(window.analyser.fftSize);
          window.analyser.getFloatTimeDomainData(samples);
          peak = Math.max(peak, ...samples.map(Math.abs));
          receivedAudio = samples.some(sample => Math.abs(sample) > 0.02);
        }
        if (receivedAudio) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const stats = [...(await window.bot.getStats()).values()];
      return {
        receivedAudio, peak,
        outgoingAudioTracks: window.bot.getSenders().filter(sender => sender.track?.kind === 'audio').length,
        incomingAudioPackets: stats.filter(stat => stat.type === 'inbound-rtp' && stat.kind === 'audio').reduce((sum, stat) => sum + stat.packetsReceived, 0),
      };
    });
    const silentInputPeak = await page.evaluate(async () => {
      const input = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
      const analyser = window.audio.createAnalyser();
      window.audio.createMediaStreamSource(input).connect(analyser);
      const silent = window.audio.createGain(); silent.gain.value = 0;
      analyser.connect(silent).connect(window.audio.destination);
      let peak = 0;
      for (let i = 0; i < 10; i++) {
        await new Promise(resolve => setTimeout(resolve, 50));
        const samples = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(samples);
        peak = Math.max(peak, ...samples.map(Math.abs));
      }
      input.getTracks().forEach(track => track.stop()); analyser.disconnect(); silent.disconnect();
      return peak;
    });
    check(silentInputPeak < 0.00001, 'fake microphone is silent (no Chromium test tone)');
    const frameResult = await observerPage.evaluate(async () => {
      const video = document.querySelector('#remote');
      await Promise.race([video.play(), new Promise((_, reject) => setTimeout(() => reject(new Error('Remote video play timed out')), 2000))]);
      const canvas = document.createElement('canvas');
      canvas.width = 640; canvas.height = 360;
      canvas.getContext('2d').drawImage(video, 0, 0, 640, 360);
      document.body.append(canvas);
      const pixels = canvas.getContext('2d').getImageData(0, 0, 640, 360).data;
      let mint = 0, white = 0, dark = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const [r, g, b] = pixels.slice(i, i + 3);
        if (r > 145 && r < 215 && g > 205 && b > 190) mint++;
        if (r > 220 && g > 220 && b > 220) white++;
        if (r < 45 && g < 55 && b < 70) dark++;
      }
      return {
        width: video.videoWidth, height: video.videoHeight,
        mint, white, dark,
        frame: canvas.toDataURL(),
      };
    });
    media = { ...frameResult, ...audioResult };
    } finally { await observerBrowser.close(); }
    console.log('Remote peer measurements:', JSON.stringify({ ...media, frame: undefined }));
    if (process.env.BRANDING_TEST_FRAME) {
      require('node:fs').writeFileSync(process.env.BRANDING_TEST_FRAME, Buffer.from(media.frame.split(',')[1], 'base64'));
    }
    check(media.width >= 320 && media.height >= 180 && media.width / media.height === 16 / 9, 'remote peer receives readable 16:9 static camera frames');
    check(media.mint > 100 && media.white > 2500 && media.dark > 100000, 'remote frame contains Meetings AI mint/white logo on dark background');
    check(media.outgoingAudioTracks === 0, 'bot publishes no microphone/audio track');
    check(media.receivedAudio && media.incomingAudioPackets > 0, 'incoming participant audio still reaches bot over WebRTC');
    console.log(`PASS ${checks} global-logo checks; these are local fixtures/peer tests, not live Teams/Meet acceptance.`);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
