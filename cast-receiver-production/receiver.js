const context = cast.framework.CastReceiverContext.getInstance();
const playerManager = context.getPlayerManager();

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
      } catch (e) {
        console.error('caption convert failed: ' + e.message);
      }
    })
  );
}

// --- LOAD interceptor (async to allow manifest inspection) ---
playerManager.setMessageInterceptor(
  cast.framework.messages.MessageType.LOAD,
  async (loadRequestData) => {
    if (!loadRequestData || !loadRequestData.media) {
      return loadRequestData;
    }

    const url = loadRequestData.media.contentUrl || loadRequestData.media.contentId;

    // Inspect the HLS manifest to detect encryption and segment containers
    try {
      const masterRes = await fetch(url);
      const masterText = await masterRes.text();

      // Find the first video variant URL and the first audio rendition URL.
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

      // Fetch variant to check for encryption and segment container
      if (variantUrl) {
        const variantRes = await fetch(variantUrl);
        const variantText = await variantRes.text();

        const hasAES128 = variantText.includes('#EXT-X-KEY') && variantText.includes('AES-128');
        const hasEndList = variantText.includes('#EXT-X-ENDLIST');

        // For demuxed streams, fetch the audio rendition too: its container can
        // differ from the video (e.g. Broadpeak packages video .ts, audio .aac).
        let audioText = null;
        if (audioUrl) {
          try {
            const audioRes = await fetch(audioUrl);
            audioText = await audioRes.text();
          } catch (audErr) {
            console.error('audio playlist fetch failed: ' + audErr.message);
          }
        }

        const videoExt = firstSegExt(variantText);
        const audioExt = audioText ? firstSegExt(audioText) : null;

        // Set segment format based on the ACTUAL detected containers.
        //
        // Two independent levers in CAF:
        //   hlsVideoSegmentFormat  -> the video segment container (TS or FMP4)
        //   hlsSegmentFormat       -> the PACKED-AUDIO segment container
        //                             (AAC/AC3/MP3/TS/FMP4) for demuxed audio.
        // (There is no hlsAudioSegmentFormat property.)
        const V = cast.framework.messages.HlsVideoSegmentFormat;

        if (hasAudioGroup) {
          // DEMUXED: CAF cannot reliably auto-detect standalone renditions, so
          // hint each explicitly. The audio container can differ from the video,
          // e.g. the Broadpeak nPVR backend packages video as .ts but audio as
          // raw .aac -- forcing audio=TS stalled 體育1台, while 體育MAX (audio=.ts)
          // played. Detect both from their own playlists.
          if (videoExt === 'fmp4') {
            loadRequestData.media.hlsVideoSegmentFormat = V.FMP4;
          } else if (videoExt === 'ts') {
            loadRequestData.media.hlsVideoSegmentFormat = V.MPEG2_TS;
          }
          const af = audioHlsFormat(audioExt);
          if (af) loadRequestData.media.hlsSegmentFormat = af;
        } else if (hasAES128 && hasEndList) {
          // MUXED + AES-128: forcing a format breaks decryption / stalls;
          // CAF auto-detects the encrypted muxed container correctly (this is
          // what makes 體育1~4台 play). Leave formats untouched.
        } else if (videoExt === 'fmp4') {
          loadRequestData.media.hlsVideoSegmentFormat = V.FMP4;
          loadRequestData.media.hlsSegmentFormat =
            cast.framework.messages.HlsSegmentFormat.FMP4;
        } else {
          // Muxed clear TS (legacy default that historically worked).
          loadRequestData.media.hlsVideoSegmentFormat = V.MPEG2_TS;
          loadRequestData.media.hlsSegmentFormat =
            cast.framework.messages.HlsSegmentFormat.TS;
        }

        // Fix stream type
        if (!hasEndList && loadRequestData.media.streamType !== 'LIVE') {
          loadRequestData.media.streamType =
            cast.framework.messages.StreamType.LIVE;
        } else if (hasEndList && loadRequestData.media.streamType !== 'BUFFERED') {
          loadRequestData.media.streamType =
            cast.framework.messages.StreamType.BUFFERED;
        }
      }
    } catch (e) {
      console.error('manifest inspect failed: ' + e.message);
    }

    // Convert SRT sideloaded captions to WebVTT so CAF can render them. Run
    // independently of the manifest inspection above so either can fail alone.
    await inlineSrtCaptionsAsVtt(loadRequestData);

    return loadRequestData;
  }
);

context.start();
