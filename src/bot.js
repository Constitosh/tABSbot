<div id="om-flow">
  <style>
  /* ===== Base layout (scoped) ===== */
  #om-flow { color:#fff; }
  #om-flow, #om-flow * { box-sizing: border-box; }
  #om-flow .stage {
    display: none;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    min-height: 85vh;
    text-align: center;
    position: relative;
  }
  #om-flow .button-row {
    display: flex; gap: 2rem; margin-top: 2rem;
    flex-wrap: wrap; justify-content: center;
  }
  #om-flow .button-row img {
    max-width: 200px; height: auto; cursor: pointer;
    transition: transform .3s ease, filter .3s ease;
  }
  #om-flow .button-row img:hover { transform: scale(1.08); filter: brightness(1.05); }

  #om-flow input[type="text"] {
    padding: 10px; font-size: 1rem; margin-bottom: 1rem;
    width: 80%; max-width: 300px; text-align: center;
  }

  #om-flow #email-input {
    background-color: rgba(0, 0, 0, 0.25);
    border: none; border-radius: 10px; padding: 12px 20px;
    font-size: 1rem; color: white; width: 80%; max-width: 400px;
    text-align: center; margin: 20px 0; outline: none;
  }
  #om-flow #email-input::placeholder { color: rgba(255,255,255,0.5); }

  #om-flow .submit-button-img { width: 140px; cursor: pointer; transition: transform .2s ease; }
  #om-flow .submit-button-img:hover { transform: scale(1.05); }

  /* Two-column layout (stage6) */
  #om-flow .fields-grid {
    display: grid; grid-template-columns: 1fr 1fr;
    gap: 12px 24px; width: min(720px, 90vw); margin: 16px auto 24px;
  }
  #om-flow .pill-input {
    width: 100%; padding: 12px 16px; border-radius: 9999px;
    border: 1px solid rgba(255,255,255,0.08);
    background: rgba(0,0,0,0.35); color: #fff; font-size: 16px; outline: none;
  }
  #om-flow .pill-input::placeholder { color: rgba(255,255,255,0.5); }
  @media (max-width: 520px) { #om-flow .fields-grid { grid-template-columns: 1fr; } }

  /* ===== HUD (bottom-left) for chosen drinks ===== */
  #om-flow #hud-drinks {
    position: fixed; bottom: 18px; left: 18px; z-index: 1000;
    display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
    pointer-events: none;
  }
  #om-flow #hud-drinks img {
    width: 5vw; min-width: 28px; max-width: 64px; height: auto;
    filter: drop-shadow(0 2px 4px rgba(0,0,0,.4));
    pointer-events: auto;
  }

  /* ===== DRUNK MODE ===== */
  #om-flow .stage.drunk { isolation: isolate; }
  #om-flow .stage.drunk::before,
  #om-flow .stage.drunk::after {
    content: ""; position: absolute; inset: -2vmax; pointer-events: none; z-index: 2;
  }
  /* Vignette (strength scaled by --vig) */
  #om-flow .stage.drunk::before {
    background: radial-gradient(120% 100% at 50% 50%,
      rgba(0,0,0,0) 55%,
      rgba(0,0,0,1) 80%,
      rgba(0,0,0,1) 100%);
    mix-blend-mode: multiply;
    opacity: var(--vig, .15);
  }
  /* Scanlines / grain (scaled by --grain) */
  #om-flow .stage.drunk::after {
    background: repeating-linear-gradient(0deg,
      rgba(255,255,255,0.06) 0 2px, rgba(0,0,0,0.06) 2px 4px);
    opacity: var(--grain, .2);
  }

  @keyframes om-bob-var {
    0%   { transform: translate(calc(var(--dx, 1px) * -1), var(--dy, 1px)) rotate(calc(var(--rot, .2deg) * -1)); }
    100% { transform: translate(var(--dx, 1px), calc(var(--dy, 1px) * -1)) rotate(var(--rot, .2deg)); }
  }

  /* Apply to WEBP images only to keep UI readable */
  #om-flow .stage.drunk img[src$=".webp"] {
    filter: url(#rgb-split-4) blur(var(--blur, .4px));
    animation: om-bob-var var(--dur, 3.4s) ease-in-out infinite alternate;
    transform: translateZ(0);
    will-change: transform, filter;
  }
  #om-flow .stage.drunk img[src$=".webp"]:hover,
  #om-flow .stage.drunk img[src$=".webp"]:focus {
    filter: url(#rgb-split-2) blur(.15px);
    transform: scale(1.035);
  }

  /* Stage 8 multipick: selected state + friendly bump */
  #om-flow .pickable.selected {
    outline: 4px solid #ff4d6d; outline-offset: 2px;
    filter: brightness(1.15) saturate(1.2); transform: scale(1.05);
  }
  @keyframes om-bump { 0% { transform: translateX(0) } 33% { transform: translateX(-4px) } 66% { transform: translateX(4px) } 100% { transform: translateX(0) } }
  #om-flow .pickable.bump { animation: om-bump .18s ease; }

  /* pill-style clickable rows */
  #om-flow .choice-list {
    width: min(720px, 90vw); margin: 16px auto 20px; display: flex; flex-direction: column; gap: 12px;
  }
  #om-flow .pill-button {
    width: 100%; padding: 14px 18px; border-radius: 9999px;
    border: 1px solid rgba(255,255,255,0.08);
    background: rgba(0,0,0,0.35); color: #fff; font-size: 18px; line-height: 1.2; text-align: left; cursor: pointer;
    transition: transform .2s ease, filter .2s ease, background .2s ease, border-color .2s ease;
  }
  #om-flow .pill-button strong { letter-spacing: .5px; }
  #om-flow .pill-button span { opacity: .7; font-style: italic; }
  #om-flow .pill-button:hover { transform: translateY(-1px); filter: brightness(1.05); }
  #om-flow .pill-button.selected {
    border-color: rgba(255,77,109,.85); box-shadow: 0 0 0 3px rgba(255,77,109,.25) inset; background: rgba(255,77,109,.18);
  }
  </style>

  <!-- SVG filters -->
  <svg width="0" height="0" style="position:absolute">
    <filter id="rgb-split-2">
      <feColorMatrix in="SourceGraphic" type="matrix"
        values="1 0 0 0 0   0 1 0 0 0   0 0 1 0 0   0 0 0 1 0" result="src"/>
      <feColorMatrix in="src" type="matrix" values="1 0 0 0 0   0 0 0 0 0   0 0 0 0 0   0 0 0 1 0" result="r"/>
      <feOffset in="r" dx="-1.1" dy="0" result="rS"/>
      <feColorMatrix in="src" type="matrix" values="0 0 0 0 0   0 1 0 0 0   0 0 0 0 0   0 0 0 1 0" result="g"/>
      <feColorMatrix in="src" type="matrix" values="0 0 0 0 0   0 0 1 0 0   0 0 0 1 0" result="b"/>
      <feOffset in="b" dx="1.1" dy="0" result="bS"/>
      <feBlend in="rS" in2="g" mode="screen" result="rg"/>
      <feBlend in="rg" in2="bS" mode="screen"/>
    </filter>

    <filter id="rgb-split-4">
      <feColorMatrix in="SourceGraphic" type="matrix"
        values="1 0 0 0 0   0 1 0 0 0   0 0 1 0 0   0 0 0 1 0" result="src"/>
      <feColorMatrix in="src" type="matrix" values="1 0 0 0 0   0 0 0 0 0   0 0 0 0 0   0 0 0 1 0" result="r"/>
      <feOffset in="r" dx="-3.2" dy="0" result="rS"/>
      <feColorMatrix in="src" type="matrix" values="0 0 0 0 0   0 1 0 0 0   0 0 0 0 0   0 0 0 1 0" result="g"/>
      <feColorMatrix in="src" type="matrix" values="0 0 0 0 0   0 0 1 0 0   0 0 0 1 0" result="b"/>
      <feOffset in="b" dx="3.2" dy="0" result="bS"/>
      <feBlend in="rS" in2="g" mode="screen" result="rg"/>
      <feBlend in="rg" in2="bS" mode="screen"/>
    </filter>
  </svg>

  <!-- HUD container -->
  <div id="hud-drinks" aria-label="Selected drinks"></div>

  <!-- ===== Stages ===== -->

  <!-- 1 -->
  <div class="stage" id="stage1" data-question="Are you 4+?">
    <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68944c4aaa84a51b3635fd78_4%2B.webp" style="width: 15%;">
    <div class="button-row">
      <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68944c2e1f95e4118fb52508_but_FUCK_YEA.webp" data-answer="Yes" data-next="stage2">
      <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68944c2e6e0313f4674a5561_but_HELL_NO.webp" data-answer="No" data-next="stage1a">
    </div>
  </div>

  <!-- 1a -->
  <div class="stage" id="stage1a" data-question="Watch this kid">
    <iframe width="560" height="315" src="https://www.youtube.com/embed/OTUg_4TvCWY?si=tCIXYj59aEcOWORA"
      title="YouTube video player" frameborder="0"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
      referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>
    <div class="button-row" style="margin-top:1.25rem">
      <img
        src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68944c2e5006e62f99bfc57d_but_WEGOOD.webp"
        data-answer="Continue" data-next="stage2" style="width: 100%;">
    </div>
  </div>

  <!-- 2 -->
  <div class="stage" id="stage2" data-question="Welcome">
    <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68944c4b8c4f45d6b5fbc7ce_dept.urinal_logo.webp" style="width: 15%;">
    <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68944c4827f2378f1c28fdc2_text_WELCOME.webp" style="width: 30%;">
    <div class="button-row">
      <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68944c2e0f134385303a50a7_but_HELL_YEA.webp" data-answer="Yes" data-next="stage3">
      <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68944c2d280a716d2553c0e3_but_FUCK_NO.webp" data-answer="No" data-next="stage4">
    </div>
  </div>

  <!-- 3 -->
  <div class="stage" id="stage3" data-question="Choose your drink">
    <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68944c48e2364f60015f85fb_text_CHOOSEDRINK.webp">
    <div class="button-row">
      <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68944c492180c75ea6736136_drink_WHISKY.webp" style="width: 22%;" data-answer="Whiskey" data-next="stage4" data-drink="whiskey">
      <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68944c49666b210c9ec32d79_drink_BEER.webp" style="width: 22%;" data-answer="Beer" data-next="stage4" data-drink="beer">
      <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68944c493af77a3b43430070_drink_ROSE.webp" style="width: 22%;" data-answer="Rose" data-next="stage4" data-drink="rose">
      <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68944c49666b210c9ec32d7e_drink_METHCOLA.webp" style="width: 22%;" data-answer="Methcola" data-next="stage4" data-drink="methcola">
    </div>
  </div>

  <!-- 4 -->
  <div class="stage" id="stage4" data-question="Drop your email, Discord, or X account">
    <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68944c4831862608201c8fe8_text_DROPYOUREMAIL.webp" style="width: 30%;">
    <input id="email-input" type="text" placeholder="@mail.com / @twitter / discord#1234">
    <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68944c2e9ddcc6eb0e868242_but_SUBMIT.webp" class="submit-button-img" data-next="stage5" onclick="submitEmail()">
  </div>

  <!-- 5 -->
  <div class="stage" id="stage5" data-question="Want another drink?">
    <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68944c487db9e92ca95798f2_text_WANTANOTHER.webp" style="width: 25%;">
    <div class="button-row">
      <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68944c2e48630ceb7310f69c_but_SURE.webp" data-answer="Sure" data-next="stage3a">
      <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68944c2e5006e62f99bfc57d_but_WEGOOD.webp" data-answer="We good" data-next="stage6">
    </div>
  </div>

  <!-- 3a -->
  <div class="stage" id="stage3a" data-question="Choose your drink2">
    <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68944c487db9e92ca95798f2_text_WANTANOTHER.webp">
    <div class="button-row">
      <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68944c492180c75ea6736136_drink_WHISKY.webp" style="width: 22%;" data-answer="Whiskey" data-next="stage6" data-drink="whiskey">
      <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68944c49666b210c9ec32d79_drink_BEER.webp" style="width: 22%;" data-answer="Beer" data-next="stage6" data-drink="beer">
      <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68944c493af77a3b43430070_drink_ROSE.webp" style="width: 22%;" data-answer="Rose" data-next="stage6" data-drink="rose">
      <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68944c49666b210c9ec32d7e_drink_METHCOLA.webp" style="width: 22%;" data-answer="Methcola" data-next="stage6" data-drink="methcola">
    </div>
  </div>

  <!-- 6 -->
  <div class="stage" id="stage6" data-question="Provide 10 intel items">
    <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68944c4831862608201c8ff2_text_NAMEWHO.webp" style="width: 33%;">
    <div class="tenfields">
      <div class="fields-grid">
        <input class="pill-input" data-label="Field 1"  placeholder="Name 1">
        <input class="pill-input" data-label="Field 2"  placeholder="Alpha 2">
        <input class="pill-input" data-label="Field 3"  placeholder="Token 3">
        <input class="pill-input" data-label="Field 4"  placeholder="Whale 4">
        <input class="pill-input" data-label="Field 5"  placeholder="Rekt 5">
        <input class="pill-input" data-label="Field 6"  placeholder="Fed 6">
        <input class="pill-input" data-label="Field 7"  placeholder="Ghost 7">
        <input class="pill-input" data-label="Field 8"  placeholder="Noise 8">
        <input class="pill-input" data-label="Field 9"  placeholder="Anon 9">
        <input class="pill-input" data-label="Field 10" placeholder="Legacy 10">
      </div>
      <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68944c2e9ddcc6eb0e868242_but_SUBMIT.webp"
        alt="Submit" class="submit-button-img" onclick="submitTenFields('stage7')">
    </div>
  </div>

  <!-- 7a -->
  <div class="stage" id="stage7a" data-question="Choose your drink2">
    <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68944c487db9e92ca95798f2_text_WANTANOTHER.webp">
    <div class="button-row">
      <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68944c492180c75ea6736136_drink_WHISKY.webp" style="width: 22%;" data-answer="Whiskey" data-next="stage8" data-drink="whiskey">
      <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68944c49666b210c9ec32d79_drink_BEER.webp" style="width: 22%;" data-answer="Beer" data-next="stage8" data-drink="beer">
      <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68944c493af77a3b43430070_drink_ROSE.webp" style="width: 22%;" data-answer="Rose" data-next="stage8" data-drink="rose">
      <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68944c49666b210c9ec32d7e_drink_METHCOLA.webp" style="width: 22%;" data-answer="Methcola" data-next="stage8" data-drink="methcola">
    </div>
  </div>

  <!-- 7 -->
  <div class="stage" id="stage7" data-question="Hit you with anotherone?">
    <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68944c48d5486846531fbc52_text_HITYOUWITH.webp" style="width: 25%;">
    <div class="button-row">
      <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68944c2efff0d5446aac63b9_but_LFG.webp" data-answer="LFG" data-next="stage7a">
      <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68944c2d4818ae3dc28b2638_but_....webp" data-answer="..." data-next="stage8">
    </div>
  </div>

  <!-- 8 (characters; choose EXACTLY two, then submit) -->
  <div class="stage" id="stage8" data-question="Choose Characters">
    <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68944c48dadbf3dfd6b03edd_text_CHOOSETWO.webp" style="width:35%;max-width:600px;">

    <div class="button-row">
      <img class="pickable" src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68afdb600b633baa8279907a_fibonasti.webp" style="width: 22%;" data-answer="FIBONASTY">
      <img class="pickable" src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68afdb5f721d512cd2661800_diamonboy.webp" style="width: 22%;" data-answer="DIAMOND">
      <img class="pickable" src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68afdb60b1f9f15965fb80c8_shortditch.webp" style="width: 22%;" data-answer="SHORTDITCH">
      <img class="pickable" src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68afdb6272dec557c3de0863_silkshady.webp" style="width: 22%;" data-answer="SILKSHADY">
    </div>

    <div class="button-row">
      <img class="pickable" src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68afdb62501dcb9f6a7dada0_hal69420.webp" style="width: 22%;" data-answer="HAL">
      <img class="pickable" src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68afdb622843f377c6258e68_ganslur.webp" style="width: 22%;" data-answer="GANSLUR">
      <img class="pickable" src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68afdb5f6269e6adb33342fc_fraudfeller.webp" style="width: 22%;" data-answer="FRAUDFELLER">
      <img class="pickable" src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68afdb627160c9acd59cc749_nakatoshi.webp" style="width: 22%;" data-answer="NAKATOSHI">
    </div>

    <div class="button-row" style="position:relative; display:inline-block;">
      <img id="stage8-submit"
           src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68944c2e9ddcc6eb0e868242_but_SUBMIT.webp" data-next="stage9" style="width: 80%; cursor:pointer;">
      <span id="stage8-counter"
            style="position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
                   font-family:'Courier New', monospace; font-size:1.2em; color:white; text-shadow:0 0 6px black; display:none;">
      </span>
    </div>
  </div>

  <!-- 9 -->
  <div class="stage" id="stage9" data-question="Soberup">
    <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68a740e06e93419d87be5a28_text_STAGE9.webp" style="width: 30%;">
    <div class="button-row">
      <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68a740c766336784522b680c_image.webp" data-answer="yesplease" data-next="stage10">
      <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68a740cd9c2814fe5fb27c1e_image.webp" data-answer="nothanks" data-next="stage11">
      <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68b05b9186df928db341e76f_image.webp" data-answer="restroom" data-next="stage12">
    </div>
  </div>

  <!-- 10 MOVIE STAGE -->
  <div class="stage" id="stage10" data-question="Watch this">
    <video
      id="movie1"
      src="https://om.thefakerug.com/ednafo/ednafo1.mp4"
      playsinline muted autoplay preload="auto"
      style="max-width:30%; width:30%; height:auto; border-radius:12px; cursor:pointer;"
      data-autoplay data-restart
    ></video>

    <div class="button-row" style="margin-top:1.25rem">
      <img
        src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68b05b8bcbdbe5930e515948_image.webp"
        data-answer="Continue" data-next="stage14" style="width: 125%;">
    </div>
  </div>

  <!-- 11 -->
  <div class="stage" id="stage11" data-question="A-Alcoholics_redirect">
    <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68a740d959074a3172ba15ac_image.webp" style="width: 25%;">
    <div class="button-row">
      <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68a740e803521cce4f01b771_image.webp" data-answer="link_to_aa"
           onclick="window.location.href='https://www.aa.org/find-aa';" style="cursor: pointer;">
    </div>
  </div>

  <!-- 12 -->
  <div class="stage" id="stage12" data-question="No-restroom">
    <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68a740f982444e224f5e7027_image.webp" alt="Out of order urinal"
         style="width: 25%; max-width: 640px; margin: 1rem 0 1.25rem;">

    <div class="button-row">
      <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68a7418c0fc37a814fcbfb78_image.webp"
           alt="Fine" data-answer="fine" data-next="stage10" style="width: 100%;">
      <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68a741925a3e94d85d1197bc_image.webp"
           alt="But you're the Dept. of Urinals" data-answer="dept-of-urinals" data-next="stage13" style="width: 100%;">
    </div>
  </div>

  <!-- 13 -->
  <div class="stage" id="stage13" data-question="Goaway">
    <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68a741974ac7c1810db5214a_image.webp" style="width: 15%;">
    <div class="button-row">
      <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68a7418c0fc37a814fcbfb78_image.webp" data-answer="fine" data-next="stage10">
    </div>
  </div>

  <!-- 14 -->
  <div class="stage" id="stage14" data-question="Choose your currency allegiance">
    <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68a7419e944f269cff50dbe4_image.webp" alt="Choose your currency" style="width:40%;max-width:700px;">
    <div class="choice-list">
      <button class="pill-button" data-answer="$USD"><strong>$USD</strong> <span> - I believe in the great lie</span></button>
      <button class="pill-button" data-answer="BITCOIN"><strong>BITCOIN</strong> <span> - I see salvation through scarcity</span></button>
      <button class="pill-button" data-answer="JPEG"><strong>JPEG</strong> <span> - I trust vibes over fundamentals</span></button>
      <button class="pill-button" data-answer="MX"><strong>MX</strong> <span> - Meth is what keeps me alive</span></button>
      <button class="pill-button" data-answer="DEBT"><strong>DEBT</strong> <span> - I was born into it</span></button>
      <button class="pill-button" data-answer="$FOMO"><strong>$FOMO</strong> <span> - The fastest horse die first</span></button>
    </div>
    <div class="button-row">
      <img id="currency-submit"
           src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68944c2e9ddcc6eb0e868242_but_SUBMIT.webp"
           alt="Submit" style="width:160px;cursor:not-allowed;opacity:.5;"
           data-next="stage15">
    </div>
  </div>

  <!-- 15 (BTC) -->
  <div class="stage" id="stage15" data-question="BTC wallet verification">
    <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68944c4b8c4f45d6b5fbc7ce_dept.urinal_logo.webp" style="width: 15%;">
    <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68a741c13810b0c31a323fb7_image.webp" style="width: 30%;">

    <div class="button-row" style="flex-direction:column;align-items:center;gap:12px;max-width:420px;width:90%;">
      <button id="btc-connect" class="pill-button" style="text-align:center;">Connect BTC Wallet (Xverse / UniSat / Leather)</button>
      <button id="btc-sign" class="pill-button" style="text-align:center;" disabled>Sign Message</button>
      <div id="btc-status" style="opacity:.85;font-size:.95rem"></div>
      <input type="hidden" id="btc-address">
      <input type="hidden" id="btc-signature">
      <input type="hidden" id="btc-message">
    </div>

    <div class="button-row">
      <img id="stage15-continue"
           src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68a741cab35d5b4a18539e96_image.webp"
           data-answer="Yes" data-next="stage15a"
           style="width: 100%; max-width:320px; cursor:not-allowed; opacity:.5;">
    </div>
  </div>

  <!-- 15a (Cardano placeholder) -->
  <div class="stage" id="stage15a" data-question="Cardano wallet verification">
    <div class="button-row" style="flex-direction:column;align-items:center;gap:12px;max-width:480px;width:90%;">
      <button id="ada-connect" class="pill-button" style="text-align:center;">Connect Cardano Wallet (Vespr / Eternl / Nami)</button>
      <button id="ada-sign" class="pill-button" style="text-align:center;" disabled>Sign Message</button>
      <input id="ada-txhash" class="pill-input" placeholder="Paste a TX hash (optional)" style="text-align:center;">
      <div id="ada-status" style="opacity:.85;font-size:.95rem"></div>
      <input type="hidden" id="ada-address">
      <input type="hidden" id="ada-signature">
      <input type="hidden" id="ada-pubkey">
      <input type="hidden" id="ada-message">
    </div>

    <div class="button-row">
      <img id="stage15a-continue"
           src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68944c2e9ddcc6eb0e868242_but_SUBMIT.webp"
           data-answer="Continue" data-next="stage16"
           style="width: 100%; max-width:320px; cursor:not-allowed; opacity:.5;">
    </div>
  </div>

  <!-- 16 -->
  <div class="stage" id="stage16" data-question="Welcome">
    <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68944c4b8c4f45d6b5fbc7ce_dept.urinal_logo.webp" style="width: 15%;">
    <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68a741d03c3400e20c0a305a_image.webp" style="width: 30%;">
    <div class="button-row">
      <img src="https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68a741dd35272408e0934e38_image.webp" data-answer="link_to_ednafo_x"
           onclick="window.location.href='https://x.com/ednafo91924';" style="cursor: pointer; width: 25%;">
    </div>
  </div>

  <!-- ===== Sats-Connect loader: self-host first, then CDN fallbacks ===== -->
  <script>
  (function loadSatsConnect() {
    const sources = [
      'https://api.thefakerug.com/static/sats-connect-3.6.1/index.umd.js', // self-host FIRST
      'https://cdn.jsdelivr.net/npm/sats-connect@3.6.1/dist/index.umd.js',
      'https://unpkg.com/sats-connect@3.6.1/dist/index.umd.js'
    ];
    let i = 0;
    function next() {
      if (i >= sources.length) return;
      const s = document.createElement('script');
      s.src = sources[i++];
      s.async = true;
      s.onload = function () {
        // Basic sanity check; UMD should expose one of these:
        if (window.Wallet?.request || window.satsConnect?.request) {
          window.__satsLoaded = true;
        } else {
          // Try next source if global not exposed as expected
          next();
        }
      };
      s.onerror = next;
      document.head.appendChild(s);
    }
    next();
  })();
  </script>

  <script>
  /* ============ Config ============ */
  const BACKEND_URL = "https://api.thefakerug.com/api/submit";
  const APP_DETAILS = {
    name: 'ednafo',
    icon: 'https://cdn.prod.website-files.com/615d5f36962d65ff61d1cf80/68944c4b8c4f45d6b5fbc7ce_dept.urinal_logo.webp'
  };

  /* ============ State & Utilities ============ */
  let currentStage = "stage1";
  const answers = [];
  const chosenDrinks = [];
  const hud = document.querySelector('#om-flow #hud-drinks');

  let submittedOnce = false;
  let btc = { address: null, signature: null, message: null, provider: null, signedOk: false, protocol: null };
  let ada = { address: null, signature: null, pubKey: null, message: null, provider: null, txHash: null, signedOk: false };

  let refuseDrinks = false;

  function recordAnswer(question, answer) {
    if (typeof answer !== "undefined" && answer !== null)
      answers.push({ question, answer, ts: Date.now() });
  }

  function addDrinkToHUD(imgEl){
    const drinkKey = imgEl.getAttribute('data-drink') || imgEl.alt || imgEl.src;
    if (chosenDrinks.find(d => d.key === drinkKey)) return;
    const clone = new Image();
    clone.src = imgEl.src;
    clone.alt = drinkKey;
    chosenDrinks.push({ key: drinkKey, src: clone.src });
    hud?.appendChild(clone);
  }

  function seedWobble(container){
    container.querySelectorAll('img[src$=".webp"]').forEach((el) => {
      const a1 = (Math.random()*1.6).toFixed(2);
      el.style.animationDelay = `${a1}s`;
    });
  }

  function submitEmail() {
    const input = document.querySelector('#om-flow #email-input');
    const answer = input?.value.trim();
    if (answer) { recordAnswer("Contact Info", answer); goToStage("stage5"); }
    else { alert("Please enter something."); }
  }
  window.submitEmail = submitEmail;

  function submitTenFields(nextStageId = "stage7") {
    const inputs = Array.from(document.querySelectorAll('#om-flow #stage6 .pill-input'));
    const values = inputs.map(el => el.value.trim());
    if (values.some(v => !v)) { alert("Please fill out all 10 fields."); return; }
    inputs.forEach((el, i) => {
      const label = el.getAttribute('data-label') || el.placeholder || `Field ${i+1}`;
      recordAnswer(label, el.value.trim());
    });
    goToStage(nextStageId);
  }
  window.submitTenFields = submitTenFields;

  /* ============ Video autoplay + tap to unmute ============ */
  function handleStageVideos(target) {
    const vids = target.querySelectorAll("video[data-autoplay]");
    vids.forEach(v => {
      v.muted = true; v.playsInline = true;
      if (v.hasAttribute("data-restart")) { try { v.currentTime = 0; } catch {} }
      const tryPlay = () => {
        const p = v.play();
        if (p && typeof p.catch === "function") p.catch(() => v.setAttribute("controls","controls"));
      };
      if (v.readyState >= 2) { tryPlay(); }
      else { v.addEventListener("canplay", tryPlay, { once:true }); try { v.load(); } catch {} }
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    const vid = document.getElementById("movie1");
    if (!vid) return;
    const enableSound = () => {
      vid.muted = false; vid.volume = 1.0;
      vid.play().catch(()=>{});
      vid.removeEventListener("click", enableSound);
      vid.removeEventListener("touchstart", enableSound);
    };
    vid.addEventListener("click", enableSound);
    vid.addEventListener("touchstart", enableSound);
  });

  /* ============ Drunk strength per stage ============ */
  function applyDrunkStrength(target, stageNum) {
    const drinksCount = chosenDrinks.length;
    if (drinksCount <= 0) return;

    const scale = (drinksCount >= 2) ? 1.7 : 1.0;
    const t = Math.min(1, Math.max(0, (stageNum - 3) / 7));
    const lerp = (a, b) => a + (b - a) * t;
    const px  = v => (v * scale).toFixed(2) + 'px';
    const deg = v => (v * scale).toFixed(2) + 'deg';
    const sec = v => (v / Math.max(1, scale*0.85)).toFixed(2) + 's';

    const dx   = lerp(0.6, 4.2);
    const dy   = lerp(0.4, 3.0);
    const rot  = lerp(0.2, 2.0);
    const blur = lerp(0.3, 2.2);
    const dur  = lerp(3.6, 2.4);
    const vig  = lerp(0.12, 0.42) * scale;
    const grain= lerp(0.15, 0.45) * scale;

    target.style.setProperty('--dx',   px(dx));
    target.style.setProperty('--dy',   px(dy));
    target.style.setProperty('--rot',  deg(rot));
    target.style.setProperty('--blur', px(blur));
    target.style.setProperty('--dur',  sec(dur));
    target.style.setProperty('--vig',  vig.toFixed(2));
    target.style.setProperty('--grain',grain.toFixed(2));
    target.classList.add('drunk');
  }

  /* ============ Router ============ */
  function goToStage(stageId) {
    document.querySelectorAll('#om-flow .stage').forEach(el => {
      el.style.display = 'none';
      el.classList.remove('drunk');
      el.style.removeProperty('--dx'); el.style.removeProperty('--dy'); el.style.removeProperty('--rot');
      el.style.removeProperty('--blur'); el.style.removeProperty('--dur'); el.style.removeProperty('--vig'); el.style.removeProperty('--grain');
    });

    const target = document.querySelector(`#om-flow #${CSS.escape(stageId)}`);
    if (!target) { console.warn('Stage not found:', stageId); return; }
    target.style.display = 'flex';
    currentStage = stageId;

    if (stageId === 'stage10') {
      const row = target.querySelector('.button-row');
      if (row) { row.style.display = 'none'; setTimeout(() => { row.style.display = 'flex'; }, 15000); }
    }

    const match = /^stage(\d+)/.exec(stageId);
    const num = match ? parseInt(match[1], 10) : NaN;

    const isDrinkStage = stageId.startsWith('stage3') || stageId.startsWith('stage7') || (!isNaN(num) && num >= 4 && num < 10);
    const shouldDrunk = (!refuseDrinks && chosenDrinks.length >= 1 && isDrinkStage);
    if (shouldDrunk) { applyDrunkStrength(target, num || 3); seedWobble(target); }

    handleStageVideos(target);

    if (stageId === 'stage16' && !submittedOnce) {
      submittedOnce = true;
      if (btc.address)   recordAnswer('BTC Address', btc.address);
      if (btc.signature) recordAnswer('BTC Signature (hex/base64)', btc.signature);
      if (btc.message)   recordAnswer('BTC Signed Message', btc.message);
      if (ada.address)   recordAnswer('ADA Address', ada.address);
      if (ada.signature) recordAnswer('ADA Signature', ada.signature);
      if (ada.pubKey)    recordAnswer('ADA PubKey', ada.pubKey);
      if (ada.txHash)    recordAnswer('ADA TX Hash', ada.txHash);
      sendAllAnswers().catch(err => console.error('Submit failed:', err));
    }
  }

  /* ============ Stage 8: pick exactly two ============ */
  function initMultiPick(stageId, maxPicks, nextStageId, saveAsQuestion) {
    const stage = document.querySelector(`#om-flow #${CSS.escape(stageId)}`);
    if (!stage) return console.warn('Stage not found for multipick:', stageId);

    const picks = new Set();
    const submitBtn = stage.querySelector(`#${CSS.escape(stageId)}-submit`);
    const counterEl = stage.querySelector(`#${CSS.escape(stageId)}-counter`);
    const imgs = Array.from(stage.querySelectorAll('img.pickable[data-answer]'));

    function updateSubmitUI() {
      if (counterEl) { counterEl.textContent = ''; counterEl.style.display = 'none'; }
    }

    imgs.forEach(img => {
      img.addEventListener('click', () => {
        const answer = img.getAttribute('data-answer');
        const isSelected = img.classList.contains('selected');
        if (isSelected) { img.classList.remove('selected'); picks.delete(answer); updateSubmitUI(); return; }
        if (picks.size >= maxPicks) { img.classList.add('bump'); setTimeout(() => img.classList.remove('bump'), 200); return; }
        img.classList.add('selected'); picks.add(answer); updateSubmitUI();
      });
    });

    if (submitBtn) {
      submitBtn.addEventListener('click', () => {
        if (picks.size !== maxPicks) { alert(`Please choose exactly ${maxPicks}.`); return; }
        const answerCombined = Array.from(picks).join(', ');
        const question = saveAsQuestion || stage.getAttribute('data-question') || 'Selection';
        recordAnswer(question, answerCombined);
        const next = (chosenDrinks.length > 0) ? nextStageId : 'stage10';
        goToStage(next);
      });
    }
    updateSubmitUI();
  }

  /* ============ Currency Stage (14) ============ */
  function initCurrencyStage(stageId){
    const stage = document.querySelector(`#om-flow #${CSS.escape(stageId)}`);
    if (!stage) return;
    const buttons = Array.from(stage.querySelectorAll('.pill-button'));
    const submit  = stage.querySelector('#currency-submit');
    let selected  = null;

    function updateSubmitUI() {
      const enabled = !!selected;
      if (submit) { submit.style.opacity = enabled ? '1' : '.5'; submit.style.cursor = enabled ? 'pointer' : 'not-allowed'; }
    }

    buttons.forEach(btn => {
      btn.addEventListener('click', () => {
        buttons.forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        selected = btn.getAttribute('data-answer');
        stage.dataset.selected = selected;
        updateSubmitUI();
      });
    });

    if (submit) {
      submit.addEventListener('click', () => {
        if (!stage.dataset.selected) { alert('Please choose one option.'); return; }
        const q = stage.getAttribute('data-question') || 'Currency';
        recordAnswer(q, stage.dataset.selected);
        const next = submit.getAttribute('data-next') || 'stage15';
        goToStage(next);
      });
    }
    updateSubmitUI();
  }

  /* ============ XVERSE / SATS-CONNECT + fallbacks ============ */

  // Canonical getter for the request() function exposed by UMD globals
  function getSatsRequestFn() {
    if (window.Wallet && typeof window.Wallet.request === 'function') return window.Wallet.request;
    if (window.satsConnect && typeof window.satsConnect.request === 'function') return window.satsConnect.request;
    if (window.BitcoinProvider && typeof window.BitcoinProvider.request === 'function') return window.BitcoinProvider.request;
    return null;
  }

  async function waitForSatsReady(timeoutMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (getSatsRequestFn()) return true;
      await new Promise(r => setTimeout(r, 150));
    }
    return !!getSatsRequestFn();
  }

  function hasUniSat(){ return typeof window.unisat !== 'undefined'; }
  function hasLeather(){ return typeof window.leather !== 'undefined' && !!window.leather?.bitcoin; }

  async function xverseConnectPayment() {
    const request = getSatsRequestFn();
    if (!request) throw new Error('Sats Connect not available');
    const AddressPurpose = { Payment: 'payment', Ordinals: 'ordinals', Stacks: 'stacks' };

    const res = await request('getAccounts', {
      purposes: [AddressPurpose.Payment],
      message: 'Connect to ednafo',
      appDetails: APP_DETAILS,
      network: { type: 'Mainnet' }
    });

    if (res?.status !== 'success') {
      throw new Error(res?.error?.message || 'getAccounts failed');
    }
    const list = res.result?.accounts || [];
    const addr = list.find(a => (a.purpose || '').toLowerCase() === 'payment')?.address
              || list[0]?.address;
    if (!addr) throw new Error('No payment address returned by wallet');
    return addr;
  }

  async function xverseSignMessage(address, message) {
    const request = getSatsRequestFn();
    if (!request) throw new Error('Sats Connect not available');

    const res = await request('signMessage', {
      address,
      message,
      appDetails: APP_DETAILS,
      network: { type: 'Mainnet' }
    });

    if (res?.status !== 'success') {
      throw new Error(res?.error?.message || 'signMessage failed');
    }
    return res.result?.signature;
  }

  async function sendAllAnswers(){
    const payload = {
      ts: new Date().toISOString(),
      answers,
      btc,
      ada,
      userAgent: navigator.userAgent
    };
    try {
      await fetch(BACKEND_URL, {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (e) {
      console.error('Submit failed', e);
    }
  }

  /* ============ Stage 15 (BTC connect + sign) ============ */
  function initBtcStage(stageId) {
    const stage = document.querySelector(`#om-flow #${CSS.escape(stageId)}`);
    if (!stage) return;

    const elConnect  = stage.querySelector('#btc-connect');
    const elSign     = stage.querySelector('#btc-sign');
    const elStatus   = stage.querySelector('#btc-status');
    const elAddr     = stage.querySelector('#btc-address');
    const elSig      = stage.querySelector('#btc-signature');
    const elMsg      = stage.querySelector('#btc-message');
    const elContinue = stage.querySelector('#stage15-continue');

    function setStatus(t) { if (elStatus) elStatus.textContent = t; }
    function gateContinue(on) {
      if (!elContinue) return;
      elContinue.style.opacity = on ? '1' : '.5';
      elContinue.style.cursor  = on ? 'pointer' : 'not-allowed';
      elContinue.dataset.enabled = on ? '1' : '0';
    }
    elContinue?.addEventListener('click', (e) => {
      if (elContinue.dataset.enabled !== '1') { e.stopPropagation(); e.preventDefault(); alert('Please connect and sign first.'); }
    }, true);

    setStatus('Click “Connect” to open your wallet (Xverse / UniSat / Leather).');

    elConnect?.addEventListener('click', async () => {
      try {
        const ready = await waitForSatsReady(8000);
        if (!ready) console.warn('Sats Connect request() not seen yet; will try fallbacks if available');

        // 1) Xverse via Sats-Connect
        try {
          const address = await xverseConnectPayment();
          btc.address  = address;
          btc.provider = 'xverse';
          btc.protocol = 'bip322'; // most Xverse Taproot addresses sign via BIP-322
          elAddr.value = address;
          setStatus(`Connected (Xverse): ${address}`);
          elSign.disabled = false;
          return;
        } catch (e) {
          console.warn('[xverse] connect failed; trying extensions next:', e?.message || e);
        }

        // 2) UniSat
        if (hasUniSat()) {
          let accs = [];
          try { accs = await window.unisat.getAccounts(); } catch {}
          if (!accs || accs.length === 0) { accs = await window.unisat.requestAccounts(); }
          if (!accs || accs.length === 0) throw new Error('No address returned by UniSat');
          btc.address  = accs[0];
          btc.provider = 'unisat';
          btc.protocol = null;
          elAddr.value = btc.address;
          setStatus(`Connected (UniSat): ${btc.address}`);
          elSign.disabled = false;
          return;
        }

        // 3) Leather
        if (hasLeather()) {
          const r = await window.leather.bitcoin.request('getAddresses', { type: 'p2tr' });
          const addr = r?.result?.addresses?.[0]?.address;
          if (!addr) throw new Error('No address returned by Leather');
          btc.address  = addr;
          btc.provider = 'leather';
          btc.protocol = 'bip322'; // p2tr + BIP-322 typical
          elAddr.value = addr;
          setStatus(`Connected (Leather): ${addr}`);
          elSign.disabled = false;
          return;
        }

        throw new Error('No supported wallet found. Install Xverse or UniSat/Leather.');
      } catch (err) {
        console.error(err);
        setStatus(`Connect failed: ${err.message || err}`);
      }
    });

    elSign?.addEventListener('click', async () => {
      try {
        if (!btc.address) { alert('Connect wallet first.'); return; }
        const message = `ednafo verification\n${new Date().toISOString()}\nnonce:${crypto.getRandomValues(new Uint32Array(1))[0]}`;
        let signature;

        if (btc.provider === 'xverse') {
          signature = await xverseSignMessage(btc.address, message);
        } else if (btc.provider === 'unisat') {
          signature = await window.unisat.signMessage(message, 'utf8');
        } else if (btc.provider === 'leather') {
          const res = await window.leather.bitcoin.request('signMessage', { message, address: btc.address });
          signature = res?.result?.signature;
        } else {
          signature = await xverseSignMessage(btc.address, message);
        }

        if (!signature) throw new Error('No signature returned');

        btc.signature = signature;
        btc.message   = message;
        btc.signedOk  = true;

        elSig.value = signature;
        elMsg.value = message;

        setStatus('Message signed. ✅');
        gateContinue(true);

        if (btc.address)   recordAnswer('BTC Address', btc.address);
        if (btc.signature) recordAnswer('BTC Signature (hex/base64)', btc.signature);
        if (btc.message)   recordAnswer('BTC Signed Message', btc.message);
        try { await sendAllAnswers(); setStatus('Message signed. ✅ Saved to server.'); }
        catch (err) { setStatus('Signed but save failed: ' + (err?.message || err)); }
      } catch (err) {
        console.error(err);
        setStatus(`Sign failed: ${err.message || err}`);
      }
    });

    elSign.disabled = true;
    gateContinue(false);
  }

  /* ============ Stage 15a (Cardano CIP-30) ============ */
  function initAdaStage(stageId) {
    const stage = document.querySelector(`#om-flow #${CSS.escape(stageId)}`);
    if (!stage) return;

    const connectBtn  = stage.querySelector('#ada-connect');
    const signBtn     = stage.querySelector('#ada-sign');
    const statusEl    = stage.querySelector('#ada-status');
    const addrEl      = stage.querySelector('#ada-address');
    const sigEl       = stage.querySelector('#ada-signature');
    const keyEl       = stage.querySelector('#ada-pubkey');
    const msgEl       = stage.querySelector('#ada-message');
    const txEl        = stage.querySelector('#ada-txhash');
    const continueEl  = stage.querySelector('#stage15a-continue');

    function setStatus(t){ if (statusEl) statusEl.textContent = t; }
    function gateContinue(on) {
      if (!continueEl) return;
      continueEl.style.opacity = on ? '1' : '.5';
      continueEl.style.cursor  = on ? 'pointer' : 'not-allowed';
      continueEl.dataset.enabled = on ? '1' : '0';
    }
    continueEl?.addEventListener('click', (e) => {
      if (continueEl.dataset.enabled !== '1') { e.stopPropagation(); e.preventDefault(); alert('Please connect and sign first.'); }
    }, true);

    const providers = [ { key: 'vespr', label: 'Vespr' }, { key: 'eternl', label: 'Eternl' }, { key: 'nami', label: 'Nami' } ];
    function getFirstAvailable() {
      for (const p of providers) {
        if (window.cardano && window.cardano[p.key] && typeof window.cardano[p.key].enable === 'function') return p.key;
      }
      return null;
    }

    function toHex(str) {
      const enc = new TextEncoder().encode(str);
      return Array.from(enc).map(b=>b.toString(16).padStart(2,'0')).join('');
    }

    let api = null;
    let providerKey = null;

    connectBtn?.addEventListener('click', async () => {
      try {
        providerKey = getFirstAvailable();
        if (!providerKey) { setStatus('No Cardano wallet detected (Vespr, Eternl, or Nami).'); return; }
        const handle = await window.cardano[providerKey].enable();
        api = handle;

        // get address (first used address fallback to reward if needed)
        let used = [];
        try { used = await api.getUsedAddresses(); } catch {}
        let addrHex = used && used[0];
        if (!addrHex) {
          try {
            const reward = await api.getRewardAddresses();
            addrHex = reward && reward[0];
          } catch {}
        }
        if (!addrHex) throw new Error('No address available from wallet.');

        ada.address = addrHex; // wallet-specific encoding
        ada.provider = providerKey;
        addrEl.value = ada.address;
        signBtn.disabled = false;
        setStatus(`Connected (${providerKey}).`);
      } catch (err) {
        console.error(err); setStatus('Connect failed: ' + (err?.message || err));
      }
    });

    signBtn?.addEventListener('click', async () => {
      try {
        if (!api) { alert('Connect wallet first.'); return; }
        const msg = `ednafo verification\n${new Date().toISOString()}\nnonce:${crypto.getRandomValues(new Uint32Array(1))[0]}`;
        const payload = toHex(msg);
        let signed;
        try { signed = await api.signData(ada.address, payload); }
        catch (e1) { try { signed = await api.experimental?.signData?.(ada.address, payload); } catch (e2) { throw e2 || e1; } }
        if (!signed) throw new Error('No signature returned');
        ada.signature = signed.signature || signed.sig || null;
        ada.pubKey    = signed.key || signed.publicKey || null;
        ada.message   = msg;
        ada.signedOk  = true;
        sigEl.value = ada.signature || '';
        keyEl.value = ada.pubKey || '';
        msgEl.value = msg;
        ada.txHash = (txEl && txEl.value.trim()) || null;
        setStatus('Message signed. ✅');
        gateContinue(true);

        if (ada.address)   recordAnswer('ADA Address', ada.address);
        if (ada.signature) recordAnswer('ADA Signature', ada.signature);
        if (ada.pubKey)    recordAnswer('ADA PubKey', ada.pubKey);
        if (ada.txHash)    recordAnswer('ADA TX Hash', ada.txHash);
        try { await sendAllAnswers(); setStatus('Message signed. ✅ Saved to server.'); }
        catch (err) { setStatus('Signed but save failed: ' + (err?.message || err)); }
      } catch (err) {
        console.error(err); setStatus('Sign failed: ' + (err?.message || err));
      }
    });

    signBtn.disabled = true;
    gateContinue(false);
    setStatus('Looking for wallets…');
  }

  /* ============ Global listeners & init ============ */
  document.addEventListener("DOMContentLoaded", function() {
    // Global [data-answer] click handler (exclude <button> so stage14 handles itself)
    document.querySelectorAll('#om-flow [data-answer]:not(button)').forEach(btn => {
      btn.addEventListener('click', () => {
        const answer = btn.getAttribute('data-answer') || '';
        const next = btn.getAttribute('data-next');
        const q = btn.closest('.stage')?.getAttribute('data-question') || '';
        recordAnswer(q, answer);
        if (answer === 'No' || answer === 'We good' || answer === '...') { refuseDrinks = true; }
        if (btn.getAttribute('data-drink')) addDrinkToHUD(btn);
        if (next) goToStage(next);
      });
    });

    initMultiPick('stage8', 2, 'stage9', 'Choose Characters');
    initCurrencyStage('stage14');
    initBtcStage('stage15');
    initAdaStage('stage15a');
    goToStage(currentStage);
  });
  </script>
</div>
