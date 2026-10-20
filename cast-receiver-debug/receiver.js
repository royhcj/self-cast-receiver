const context = cast.framework.CastReceiverContext.getInstance();
const playerManager = context.getPlayerManager();

// --- On-screen debug log ---
function dlog(msg) {
  console.log(msg);
  const el = document.getElementById('debug-log');
  if (!el) return;
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  el.textContent += time + ' ' + msg + '\n';
  el.scrollTop = el.scrollHeight;
}

function derr(msg) {
  console.error(msg);
  const el = document.getElementById('debug-log');
  if (!el) return;
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  el.textContent += time + ' ❌ ' + msg + '\n';
  el.scrollTop = el.scrollHeight;
}

// --- Summarize a media playlist's discriminating header tags ---
function summarizePlaylist(name, text) {
  const lines = text.split('\n').map((l) => l.trim());
  const tag = (p) => {
    const l = lines.find((x) => x.startsWith(p));
    return l ? l.slice(p.length) : '-';
  };
  const segs = lines.filter((l) => l && !l.startsWith('#'));
  const pdts = lines.filter((l) => l.startsWith('#EXT-X-PROGRAM-DATE-TIME:'));
  dlog(
    name +
      ': v=' + tag('#EXT-X-VERSION:') +
      ' type=' + tag('#EXT-X-PLAYLIST-TYPE:') +
      ' tgt=' + tag('#EXT-X-TARGETDURATION:') +
      ' seq=' + tag('#EXT-X-MEDIA-SEQUENCE:') +
      ' segs=' + segs.length +
      ' pdtCount=' + pdts.length
  );
  if (pdts.length) {
    dlog(name + ' firstPDT=' + pdts[0].slice('#EXT-X-PROGRAM-DATE-TIME:'.length));
    dlog(name + ' lastPDT=' + pdts[pdts.length - 1].slice('#EXT-X-PROGRAM-DATE-TIME:'.length));
  }
  dlog(name + ' disc=' + lines.filter((l) => l.startsWith('#EXT-X-DISCONTINUITY')).length);
}

// --- Detect the container of the first media segment in a playlist ---
// Returns one of: 'ts' | 'aac' | 'ac3' | 'mp3' | 'fmp4' | null
function firstSegExt(text) {
  const seg = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#'));
  if (!seg) return null;
  const path = seg.split('?')[0].toLowerCase();
  if (path.endsWith('.ts')) return 'ts';
  if (path.endsWith('.aac')) return 'aac';
  if (path.endsWith('.ac3') || path.endsWith('.ec3')) return 'ac3';
  if (path.endsWith('.mp3')) return 'mp3';
  if (path.endsWith('.mp4') || path.endsWith('.m4s') || path.endsWith('.m4a')) return 'fmp4';
  return null;
}

// Map a detected audio segment container to a CAF HlsSegmentFormat value.
function audioHlsFormat(ext) {
  const F = cast.framework.messages.HlsSegmentFormat;
  switch (ext) {
    case 'aac': return F.AAC;
    case 'ac3': return F.AC3;
    case 'mp3': return F.MP3;
    case 'fmp4': return F.FMP4;
    case 'ts': return F.TS;
    default: return null;
  }
}

// --- SRT -> WebVTT for sideloaded caption tracks ---
// CAF's <cast-media-player> only renders WebVTT text tracks. ELTA VOD captions
// are delivered as .srt (Content-Type application/octet-stream), so a track the
// sender declares as text/vtt fails to parse and no subtitle shows while casting
// (the phone plays fine because ExoPlayer parses SRT). We convert here rather
// than on the sender because the sender cannot: an https CAF receiver blocks an
// http local-server track (mixed content) and a data URI of a 60KB caption
// exceeds the ~64KB Cast LOAD message limit. On the receiver we rewrite the
// track to a blob: URL -- NOT a data: URI. The converted VTT ends up in
// trackContentId, which is echoed back to senders inside every MEDIA_STATUS
// message; with data: URIs (4 tracks x ~80KB base64) the status message blows
// past the ~64KB Cast channel message limit and never reaches the phone, so the
// sender sees no position/duration (slider stuck at 0). A blob: URL is ~50
// bytes in the status, is same-origin here, and CAF fetches it fine.
function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function srtToVtt(srt) {
  const body = stripBom(srt)
    .replace(/\r\n/g, '\n')                            // normalise CRLF
    .replace(/\r/g, '\n')                              // and lone CR
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2'); // SRT comma -> VTT dot
  return 'WEBVTT\n\n' + body;
}

function toVttBlobUrl(vtt) {
  return URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
}

// Fetch each sideloaded TEXT track; if it is SRT, convert to WebVTT and serve it
// from a blob: URL. Already-WebVTT tracks are left on their original URL. Each
// track is isolated in try/catch so one bad caption never blocks playback.
async function inlineSrtCaptionsAsVtt(loadRequestData) {
  const tracks =
    (loadRequestData.media && loadRequestData.media.tracks) || [];
  const textTracks = tracks.filter(
    (t) =>
      t &&
      t.type === cast.framework.messages.TrackType.TEXT &&
      typeof t.trackContentId === 'string' &&
      t.trackContentId &&
      !/^(data|blob):/i.test(t.trackContentId)
  );
  if (textTracks.length === 0) return;

  await Promise.all(
    textTracks.map(async (t) => {
      try {
        const text = await (await fetch(t.trackContentId)).text();
        // Already WebVTT: keep the original URL, just fix the declared type.
        if (/^\s*WEBVTT/.test(stripBom(text))) {
          t.trackContentType = 'text/vtt';
          return;
        }
        t.trackContentId = toVttBlobUrl(srtToVtt(text));
        t.trackContentType = 'text/vtt';
        dlog('caption converted SRT->VTT: ' + (t.name || t.language || t.trackId));
      } catch (e) {
        derr('caption convert failed: ' + e.message);
      }
    })
  );
}

// --- LOAD interceptor (async to allow manifest inspection) ---
playerManager.setMessageInterceptor(
  cast.framework.messages.MessageType.LOAD,
  async (loadRequestData) => {
    if (!loadRequestData || !loadRequestData.media) {
      dlog('LOAD: no media data');
      return loadRequestData;
    }

    const url = loadRequestData.media.contentUrl || loadRequestData.media.contentId;
    dlog('LOAD: ' + url);
    dlog('contentType: ' + loadRequestData.media.contentType);
    dlog('streamType: ' + loadRequestData.media.streamType);

    // Inspect the HLS manifest to detect encryption and stream type
    try {
      const masterRes = await fetch(url);
      const masterText = await masterRes.text();
      dlog('master playlist fetched (' + masterText.length + ' bytes)');

      // Check if it's a live stream (no #EXT-X-ENDLIST in master or variants)
      const isLive = masterText.includes('/live/') || !masterText.includes('#EXT-X-ENDLIST');

      // Find first variant URL
      const lines = masterText.split('\n');
      let variantUrl = null;
      let audioUrl = null;
      let hasAudioGroup = false;

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.includes('#EXT-X-MEDIA') && trimmed.includes('TYPE=AUDIO')) {
          hasAudioGroup = true;
          const audioMatch = trimmed.match(/URI="([^"]+)"/);
          if (audioMatch && audioUrl === null) {
            audioUrl = audioMatch[1].startsWith('http')
              ? audioMatch[1]
              : new URL(audioMatch[1], url).href;
          }
        }
        if (trimmed && !trimmed.startsWith('#') && variantUrl === null) {
          variantUrl = trimmed.startsWith('http')
            ? trimmed
            : new URL(trimmed, url).href;
        }
      }

      dlog('hasAudioGroup: ' + hasAudioGroup);

      // Fetch variant to check for encryption
      if (variantUrl) {
        const variantRes = await fetch(variantUrl);
        const variantText = await variantRes.text();

        const hasAES128 = variantText.includes('#EXT-X-KEY') && variantText.includes('AES-128');
        const hasFmp4 = variantText.includes('#EXT-X-MAP');
        const hasEndList = variantText.includes('#EXT-X-ENDLIST');

        dlog('AES-128: ' + hasAES128);
        dlog('fMP4: ' + hasFmp4);
        dlog('hasEndList: ' + hasEndList);

        // Fetch the audio rendition playlist (demuxed streams) so we can detect
        // its segment container, which can differ from the video (e.g. Broadpeak
        // packages video as .ts but audio as raw .aac).
        let audioText = null;
        if (audioUrl) {
          try {
            const audioRes = await fetch(audioUrl);
            audioText = await audioRes.text();
          } catch (audErr) {
            derr('audio playlist fetch FAILED: ' + audErr.message);
          }
        }

        // Dump discriminating tags of the video (and audio) media playlists so
        // we can see why some demuxed streams play and others stall forever.
        summarizePlaylist('VID', variantText);
        if (audioText) summarizePlaylist('AUD', audioText);

        const videoExt = firstSegExt(variantText);
        const audioExt = audioText ? firstSegExt(audioText) : null;
        dlog('videoExt: ' + videoExt + '  audioExt: ' + audioExt);

        // Extract the key URL for debugging
        if (hasAES128) {
          const keyMatch = variantText.match(/#EXT-X-KEY:METHOD=AES-128,URI="([^"]+)"/);
          if (keyMatch) {
            dlog('keyURL: ' + keyMatch[1]);
            // Try fetching the key to verify accessibility
            try {
              const keyRes = await fetch(keyMatch[1]);
              dlog('key fetch status: ' + keyRes.status + ' size: ' + keyRes.headers.get('content-length'));
            } catch (keyErr) {
              derr('key fetch FAILED: ' + keyErr.message);
            }
          }
        }

        // Set segment format based on the ACTUAL detected containers.
        //
        // Two independent levers in CAF:
        //   hlsVideoSegmentFormat  -> the video segment container (TS or FMP4)
        //   hlsSegmentFormat       -> the PACKED-AUDIO segment container
        //                             (AAC/AC3/MP3/TS/FMP4) for demuxed audio.
        // (There is no hlsAudioSegmentFormat property; earlier use of it was a
        //  no-op.)
        const V = cast.framework.messages.HlsVideoSegmentFormat;

        if (hasAudioGroup) {
          // DEMUXED: CAF cannot reliably auto-detect standalone renditions, so
          // hint each explicitly. The audio container can differ from the video
          // container, e.g. the Broadpeak nPVR backend packages video as .ts but
          // audio as raw .aac -- forcing audio=TS stalled 體育1台, while 體育MAX
          // (audio=.ts) played. Detect both from their own playlists.
          if (videoExt === 'fmp4') {
            loadRequestData.media.hlsVideoSegmentFormat = V.FMP4;
          } else if (videoExt === 'ts') {
            loadRequestData.media.hlsVideoSegmentFormat = V.MPEG2_TS;
          }
          const af = audioHlsFormat(audioExt);
          if (af) loadRequestData.media.hlsSegmentFormat = af;
          dlog('format: demuxed video=' + videoExt + ' audio=' + audioExt);
        } else if (hasAES128 && hasEndList) {
          // MUXED + AES-128: forcing a format breaks decryption / stalls;
          // CAF auto-detects the encrypted muxed container correctly (this is
          // what makes production 體育1~4台 play). Leave formats untouched.
          dlog('format: auto-detect (AES-128 muxed)');
        } else if (videoExt === 'fmp4') {
          loadRequestData.media.hlsVideoSegmentFormat = V.FMP4;
          loadRequestData.media.hlsSegmentFormat =
            cast.framework.messages.HlsSegmentFormat.FMP4;
          dlog('format: muxed FMP4');
        } else {
          // Muxed clear TS (legacy default that historically worked).
          loadRequestData.media.hlsVideoSegmentFormat = V.MPEG2_TS;
          loadRequestData.media.hlsSegmentFormat =
            cast.framework.messages.HlsSegmentFormat.TS;
          dlog('format: muxed TS');
        }

        // Fix stream type
        if (!hasEndList && loadRequestData.media.streamType !== 'LIVE') {
          loadRequestData.media.streamType =
            cast.framework.messages.StreamType.LIVE;
          dlog('streamType corrected to LIVE');
        } else if (hasEndList && loadRequestData.media.streamType !== 'BUFFERED') {
          loadRequestData.media.streamType =
            cast.framework.messages.StreamType.BUFFERED;
          dlog('streamType corrected to BUFFERED');
        }
      }
    } catch (e) {
      derr('manifest inspect failed: ' + e.message);
    }

    // Convert SRT sideloaded captions to WebVTT so CAF can render them. Run
    // independently of the manifest inspection above so either can fail alone.
    await inlineSrtCaptionsAsVtt(loadRequestData);

    return loadRequestData;
  }
);

// --- Error logging (most important) ---
playerManager.addEventListener(
  cast.framework.events.EventType.ERROR,
  (event) => {
    derr('ERROR code:' + event.detailedErrorCode + ' reason:' + event.reason);
    if (event.error) {
      derr('error detail: ' + JSON.stringify(event.error));
    }
  }
);

// --- Lifecycle events ---
playerManager.addEventListener(
  cast.framework.events.EventType.PLAYER_LOAD_COMPLETE,
  () => { dlog('LOAD_COMPLETE'); }
);

playerManager.addEventListener(
  cast.framework.events.EventType.BUFFERING,
  (event) => { dlog('BUFFERING: ' + event.isBuffering); }
);

playerManager.addEventListener(
  cast.framework.events.EventType.PLAYING,
  () => { dlog('PLAYING'); }
);

playerManager.addEventListener(
  cast.framework.events.EventType.PAUSE,
  () => { dlog('PAUSE'); }
);

playerManager.addEventListener(
  cast.framework.events.EventType.ABORT,
  (event) => { derr('ABORT reason:' + event.reason); }
);

playerManager.addEventListener(
  cast.framework.events.EventType.PLAYER_LOADING,
  () => { dlog('PLAYER_LOADING'); }
);

playerManager.addEventListener(
  cast.framework.events.EventType.SEGMENT_DOWNLOADED,
  (event) => { dlog('SEG size:' + event.size + ' time:' + event.downloadTime + 'ms'); }
);

playerManager.addEventListener(
  cast.framework.events.EventType.REQUEST_SEEK,
  (event) => { dlog('SEEK to:' + event.currentMediaTime); }
);

playerManager.addEventListener(
  cast.framework.events.EventType.EMSG,
  (event) => { dlog('EMSG: ' + JSON.stringify(event)); }
);

dlog('Receiver version: 13');

context.setLoggerLevel(cast.framework.LoggerLevel.DEBUG);
context.start();
