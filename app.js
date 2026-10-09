(function () {
  var API_BASE = 'https://nihongo-api.vercel.app';
  var PAGE_CHARS = 80;

  var $ = function (id) { return document.getElementById(id); };
  var history = [];
  var pages = [];
  var pageIndex = 0;
  var lastAnswer = '';
  var busy = false;
  var location = null;

  var params = new URLSearchParams(window.location.search);
  var token = params.get('k') || safeGet('token') || '';
  if (params.get('k')) safeSet('token', params.get('k'));
  if (params.get('api')) API_BASE = params.get('api');

  function safeGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function safeSet(key, value) { try { localStorage.setItem(key, value); } catch (e) {} }

  function setStatus(text) { $('status').textContent = text; }

  function paginate(text) {
    var sentences = text.match(/[^。！？!?\n]+[。！？!?]?/g) || [text];
    var result = [];
    var current = '';
    sentences.forEach(function (s) {
      s = s.trim();
      if (!s) return;
      if (current && (current + s).length > PAGE_CHARS) {
        result.push(current);
        current = '';
      }
      while (s.length > PAGE_CHARS) {
        result.push(s.slice(0, PAGE_CHARS));
        s = s.slice(PAGE_CHARS);
      }
      current += s;
    });
    if (current) result.push(current);
    return result.length ? result : [text];
  }

  function renderPage() {
    $('answerCard').hidden = false;
    $('answer').textContent = pages[pageIndex];
    $('pageInfo').textContent = pages.length > 1 ? '回答 ' + (pageIndex + 1) + '/' + pages.length : '回答';
    $('next').hidden = pages.length <= 1;
    $('next').textContent = pageIndex < pages.length - 1 ? '次へ' : '最初へ';
  }

  function refreshLocation() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(function (pos) {
      location = { lat: pos.coords.latitude, lon: pos.coords.longitude };
    }, function () {}, { maximumAge: 120000, timeout: 5000 });
  }

  function post(path, body) {
    return fetch(API_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-App-Token': token },
      body: JSON.stringify(body)
    });
  }

  function ask(text, audioBase64) {
    if (busy) return;
    if (!token) { setStatus('トークンがありません（URLに ?k= を付けて追加してください）'); return; }
    busy = true;
    setStatus(audioBase64 ? '考え中…' : '考え中… (' + text + ')');
    var body = { history: history, location: location };
    if (audioBase64) body.audio = audioBase64; else body.text = text;
    post('/api/ask', body)
      .then(function (r) {
        return r.json().then(function (data) {
          if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
          return data;
        });
      })
      .then(function (data) {
        var heard = data.heard || text;
        $('heardCard').hidden = false;
        $('heard').textContent = heard;
        lastAnswer = data.answer || '';
        pages = paginate(lastAnswer);
        pageIndex = 0;
        renderPage();
        $('speak').hidden = false;
        history.push({ role: 'user', content: heard });
        history.push({ role: 'assistant', content: lastAnswer });
        history = history.slice(-10);
        setStatus('もう一度話すときは「マイクで話す」をつまむ');
        speak();
      })
      .catch(function (err) { setStatus('エラー: ' + err.message); })
      .then(function () { busy = false; });
  }

  var audio = null;
  function speak() {
    if (!lastAnswer) return;
    post('/api/tts', { text: lastAnswer })
      .then(function (r) {
        if (r.status === 501) { $('speak').hidden = true; return null; }
        if (!r.ok) throw new Error('読み上げ失敗 ' + r.status);
        return r.blob();
      })
      .then(function (blob) {
        if (!blob) return;
        if (audio) audio.pause();
        audio = new Audio(URL.createObjectURL(blob));
        return audio.play();
      })
      .catch(function (err) { setStatus(err.name === 'NotAllowedError' ? '「読み上げ」を押すと再生します' : err.message); });
  }

  var recorder = null;

  function startRecording() {
    if (busy) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus('マイク非対応: getUserMediaがありません');
      return;
    }
    setStatus('マイクを準備中…');
    navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
      .then(function (stream) {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        var ctx = new Ctx();
        var source = ctx.createMediaStreamSource(stream);
        var processor = ctx.createScriptProcessor(4096, 1, 1);
        var chunks = [];
        var started = Date.now();
        var lastVoice = Date.now();
        var heardVoice = false;
        processor.onaudioprocess = function (e) {
          var data = e.inputBuffer.getChannelData(0);
          chunks.push(new Float32Array(data));
          var sum = 0;
          for (var i = 0; i < data.length; i++) sum += data[i] * data[i];
          var rms = Math.sqrt(sum / data.length);
          if (rms > 0.015) { lastVoice = Date.now(); heardVoice = true; }
          var elapsed = Date.now() - started;
          if ((heardVoice && Date.now() - lastVoice > 1500) || (!heardVoice && elapsed > 6000) || elapsed > 15000) stopRecording();
        };
        source.connect(processor);
        processor.connect(ctx.destination);
        recorder = { stream: stream, ctx: ctx, source: source, processor: processor, chunks: chunks, rate: ctx.sampleRate };
        $('mic').classList.add('recording');
        $('mic').textContent = '聞いています…（つまむと終了）';
        setStatus('日本語で話してください');
      })
      .catch(function (err) {
        setStatus('マイク使用不可: ' + err.name + ' ' + err.message);
      });
  }

  function stopRecording() {
    if (!recorder) return;
    var r = recorder;
    recorder = null;
    r.processor.onaudioprocess = null;
    r.source.disconnect();
    r.processor.disconnect();
    r.stream.getTracks().forEach(function (t) { t.stop(); });
    r.ctx.close();
    $('mic').classList.remove('recording');
    $('mic').textContent = 'マイクで話す';
    var samples = merge(r.chunks);
    if (samples.length < r.rate * 0.3) { setStatus('録音が短すぎました'); return; }
    ask('', toWavBase64(downsample(samples, r.rate, 16000), 16000));
  }

  function merge(chunks) {
    var length = chunks.reduce(function (n, c) { return n + c.length; }, 0);
    var out = new Float32Array(length);
    var offset = 0;
    chunks.forEach(function (c) { out.set(c, offset); offset += c.length; });
    return out;
  }

  function downsample(samples, from, to) {
    if (from <= to) return samples;
    var ratio = from / to;
    var out = new Float32Array(Math.floor(samples.length / ratio));
    for (var i = 0; i < out.length; i++) {
      var start = Math.floor(i * ratio);
      var end = Math.min(Math.floor((i + 1) * ratio), samples.length);
      var sum = 0;
      for (var j = start; j < end; j++) sum += samples[j];
      out[i] = sum / Math.max(1, end - start);
    }
    return out;
  }

  function toWavBase64(samples, rate) {
    var buffer = new ArrayBuffer(44 + samples.length * 2);
    var view = new DataView(buffer);
    var writeString = function (offset, str) { for (var i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    for (var i = 0; i < samples.length; i++) {
      var v = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    }
    var bytes = new Uint8Array(buffer);
    var binary = '';
    for (var k = 0; k < bytes.length; k += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(k, k + 0x8000));
    return btoa(binary);
  }

  $('mic').addEventListener('click', function () {
    if (recorder) stopRecording(); else startRecording();
  });

  $('say').addEventListener('change', function (e) {
    var text = e.target.value.trim();
    e.target.value = '';
    if (text) ask(text);
  });

  $('next').addEventListener('click', function () {
    pageIndex = (pageIndex + 1) % pages.length;
    renderPage();
  });

  $('speak').addEventListener('click', speak);

  $('reset').addEventListener('click', function () {
    history = [];
    pages = [];
    lastAnswer = '';
    $('heardCard').hidden = true;
    $('answerCard').hidden = true;
    $('next').hidden = true;
    $('speak').hidden = true;
    if (audio) audio.pause();
    setStatus('新しい会話を始めました');
    $('mic').focus();
  });

  var focusables = function () {
    return Array.prototype.slice.call(document.querySelectorAll('.focusable')).filter(function (el) { return !el.hidden; });
  };
  document.addEventListener('keydown', function (e) {
    var list = focusables();
    var idx = list.indexOf(document.activeElement);
    var next = null;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = list[(idx + 1) % list.length];
    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = list[(idx - 1 + list.length) % list.length];
    if (next) {
      e.preventDefault();
      next.focus();
      next.scrollIntoView({ block: 'nearest' });
    }
  });

  refreshLocation();
  setInterval(refreshLocation, 120000);
  if (!token) setStatus('トークンがありません（URLに ?k= を付けて追加してください）');
  $('mic').focus();
})();
