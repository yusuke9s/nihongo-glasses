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

  function renderCandidates(list) {
    var box = $('candidates');
    box.innerHTML = '';
    box.hidden = !list.length;
    list.forEach(function (c) {
      var b = document.createElement('button');
      b.className = 'focusable candidate';
      b.textContent = 'もしかして「' + c + '」';
      b.addEventListener('click', function () {
        history = history.slice(0, -2);
        ask(c, true);
      });
      box.appendChild(b);
    });
  }

  function ask(text, confirmed) {
    if (busy) return;
    if (!token) { setStatus('トークンがありません（URLに ?k= を付けて追加してください）'); return; }
    busy = true;
    setStatus('考え中… (' + text + ')');
    var body = { history: history, location: location };
    body.text = text;
    if (confirmed) body.confirmed = true;
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
        renderCandidates(data.candidates || []);
        lastAnswer = data.answer || '';
        pages = paginate(lastAnswer);
        pageIndex = 0;
        renderPage();
        $('speak').hidden = false;
        history.push({ role: 'user', content: heard });
        history.push({ role: 'assistant', content: lastAnswer });
        history = history.slice(-10);
        setStatus((data.candidates && data.candidates.length) ? '違っていたら下の候補を選ぶ' : 'もう一度話すときは上の欄をつまむ');
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
    renderCandidates([]);
    $('answerCard').hidden = true;
    $('next').hidden = true;
    $('speak').hidden = true;
    if (audio) audio.pause();
    setStatus('新しい会話を始めました');
    $('say').focus();
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
  $('say').focus();
})();
