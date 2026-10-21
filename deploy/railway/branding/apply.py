"""Fail-closed build-time overlay for the digest-pinned Vexa join module.

No vendored checkout edits, dependencies, API contracts, or audio changes.
Source anchors deliberately fail when upstream changes: review before upgrading.
"""
from pathlib import Path
import sys


def apply(root: Path) -> None:
    def replace(relative: str, before: str, after: str, count: int = 1) -> None:
        path = root / relative
        text = path.read_text()
        actual = text.count(before)
        if actual != count:
            raise RuntimeError(f"branding overlay: {relative}: expected {count} anchors, found {actual}")
        path.write_text(text.replace(before, after))

    replace("browser-args.ts", 'export function getJoinBrowserArgs(): string[] {',
            'import { staticLogoBrowserArgs } from "./shared/meetings-ai-static-image";\n\nexport function getJoinBrowserArgs(): string[] {')
    replace("browser-args.ts", 'return [...JOIN_BROWSER_ARGS, ...getLocaleBrowserArgs()];',
            'return staticLogoBrowserArgs([...JOIN_BROWSER_ARGS, ...getLocaleBrowserArgs()]);')

    for platform in ("googlemeet", "msteams", "zoom", "jitsi"):
        names = "isStaticLogoEnabled" if platform == "jitsi" else "enableStaticImage, isStaticLogoEnabled"
        replace(f"{platform}/join.ts", 'import { BotConfig } from "../_host";',
                'import { BotConfig } from "../_host";\nimport { ' + names + ' } from "../shared/meetings-ai-static-image";')

    # Preserve the old behavior verbatim when the deployment kill switch is off.
    for timeout in (3000, 1000):
        statement = ('if (cameraHandle) { await clickHandle(cameraHandle, "camera"); log("Camera turned off."); }'
                     if timeout == 3000 else 'if (cameraHandle) await clickHandle(cameraHandle, "camera");')
        block = f'''    try {{
      const cameraHandle = await page.waitForSelector(googleCameraButtonSelectors[0], {{ timeout: {timeout} }});
      {statement}
    }} catch (e) {{
      log("Camera already off or not found.");
    }}'''
        replace("googlemeet/join.ts", block, '''    if (isStaticLogoEnabled()) {
      await enableStaticImage(page, googleCameraButtonSelectors, log, handle => clickHandle(handle, "camera"));
    } else {
''' + block + '\n    }')

    block = '''  try {
    const cameraButton = page.locator(teamsCameraButtonSelectors[0]);
    await cameraButton.waitFor({ timeout: 5000 });
    await cameraButton.click();
    log("✅ Camera turned off");
  } catch (error) {
    log("ℹ️ Camera button not found or already off");
  }'''
    replace("msteams/join.ts", block, '''  if (isStaticLogoEnabled()) {
    await enableStaticImage(page, [
      ...teamsCameraButtonSelectors,
      '[role="switch"][aria-label*="camera" i]',
      'input[type="checkbox"][aria-label*="camera" i]',
    ], log);
  } else {
''' + block + '\n  }')

    block = '''  try {
    const videoBtn = page.locator(zoomPreviewVideoSelector);
    const videoAriaLabel = await videoBtn.getAttribute('aria-label');
    // "Stop Video" means video is on → click to stop. "Start Video" means already off → skip.
    if (videoAriaLabel === 'Stop Video') {
      await videoBtn.click();
      log('[Zoom Web] Stopped video in preview');
    }
  } catch {
    log('[Zoom Web] Could not toggle preview video (may already be off)');
  }'''
    replace("zoom/join.ts", block, '''  if (isStaticLogoEnabled()) {
    await enableStaticImage(page, [zoomPreviewVideoSelector], log);
  } else {
''' + block + '\n  }')

    replace("jitsi/join.ts", 'parts.push("config.startWithVideoMuted=true");',
            'parts.push(`config.startWithVideoMuted=${isStaticLogoEnabled() ? "false" : "true"}`);')


if __name__ == "__main__":
    apply(Path(sys.argv[1]))
