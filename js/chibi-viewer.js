// Animated chibi for the operator page's skin preview (see
// showSkinPreview() in operator-page.js): the outfit's in-game Spine
// model, in three views -- Base (the RIIC/dorm chibi), Front and Back (the
// battle sprite) -- with a picker for its animations.
//
// Files come from myrtle.moe's extracted Spine data, through this site's
// own R2 mirror (myrtleAssetUrl() in util.js), laid out as
//   spine/Building/<charId>/build_<id>.{skel,atlas,png}
//   spine/BattleFront/<charId>/<id>.{skel,atlas,png}
//   spine/BattleBack/<charId>/<id>.{skel,atlas,png}
// where <id> comes from skin_table.json (see chibiFiles()). The animation
// runtime is Esoteric Software's Spine Player 3.8 -- the game's Spine
// version (the .skel headers say 3.8.99) -- loaded from jsDelivr the first
// time a preview opens, so pages that never open one don't pay for it.
//
// Two quirks of the extracted data, both handled in loadTextures():
//  - Base-view textures are stored smaller than their .atlas says (e.g.
//    500x500 for a 748x748 atlas page). The player takes the page size from
//    the image, so the atlas coordinates land in the wrong places and the
//    chibi comes out scrambled. Each such page is scaled back up to the
//    atlas size on a canvas before the player gets it.
//  - Page file names contain "#" (e.g. build_char_250_phatom_sale#4.png),
//    which the player would request unencoded and cut off at the "#". The
//    player is handed each page's real URL instead (its rawDataURIs
//    option, keyed by the path it would otherwise request).

const ChibiViewer = (() => {
  const SPINE_BASE = "https://cdn.jsdelivr.net/gh/EsotericSoftware/spine-runtimes@3.8.95/spine-ts/";
  const SPINE_JS = {
    url: SPINE_BASE + "build/spine-player.min.js",
    integrity: "sha384-kSwKkoWfBQW5Zo/pznhhn8fsttS/QkiaoyF7NYcRZXQaW+nQ9Mr73nlNCHefQUUX",
  };
  const SPINE_CSS = {
    url: SPINE_BASE + "player/css/spine-player.css",
    integrity: "sha384-wAjp/hpDQv/mEwEQQtXecJdhZDVmBE1beHwpBQKBI1JJ7Qd7ZgrXdQKuKivpiQ87",
  };

  const VIEWS = [
    { key: "base", label: "Base", dir: "Building", prefix: "build_", animations: ["Relax", "Interact", "Move", "Sit", "Sleep", "Special"] },
    { key: "front", label: "Front", dir: "BattleFront", prefix: "", animations: ["Idle", "Attack", "Skill", "Start", "Die"] },
    { key: "back", label: "Back", dir: "BattleBack", prefix: "", animations: ["Idle", "Attack", "Skill", "Start", "Die"] },
  ];

  let runtimePromise = null;
  function loadRuntime() {
    if (runtimePromise) return runtimePromise;
    runtimePromise = new Promise((resolve, reject) => {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = SPINE_CSS.url;
      css.integrity = SPINE_CSS.integrity;
      css.crossOrigin = "anonymous";
      document.head.appendChild(css);
      const js = document.createElement("script");
      js.src = SPINE_JS.url;
      js.integrity = SPINE_JS.integrity;
      js.crossOrigin = "anonymous";
      js.onload = () => resolve(window.spine);
      js.onerror = () => {
        runtimePromise = null; // let a later preview retry
        reject(new Error("couldn't load the Spine player"));
      };
      document.head.appendChild(js);
    });
    return runtimePromise;
  }

  // Which chibi an outfit uses, from skin_table.json:
  //  - a purchasable skin has its own: battleSkin.skinOrPrefabId and
  //    buildingId, both the skinId with "@" -> "_"
  //    ("char_250_phatom@sale#4" -> "char_250_phatom_sale#4")
  //  - the default outfit and the Elite 1/2 art all share the operator's
  //    default chibi, named after its template (tmplId -- only Amiya's
  //    forms set one -- else charId); buildingId overrides the base view's
  //    (Amiya's forms share one base chibi)
  // The derivations after "||" cover game data without those fields.
  // Returns {base, front, back}, each {dir, name} with dir the charId
  // folder the files sit in.
  function chibiFiles(skin) {
    const tmpl = skin.tmplId || skin.charId;
    const ownId = skin.isBuySkin ? String(skin.skinId).replace("@", "_") : tmpl;
    const prefab = skin.battleSkin && skin.battleSkin.skinOrPrefabId;
    const battle = prefab && prefab !== "DefaultSkin" ? prefab : ownId;
    const building = skin.buildingId || ownId;
    const folder = (id) => (/^(char_\d+_[a-z0-9]+)/.exec(id) || [null, skin.charId])[1];
    const out = {};
    for (const v of VIEWS) {
      const id = v.key === "base" ? building : battle;
      out[v.key] = { dir: `spine/${v.dir}/${folder(id)}`, name: v.prefix + id };
    }
    return out;
  }

  function fileUrl(file, ext) {
    return myrtleAssetUrl(`${file.dir}/${file.name}.${ext}`);
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("couldn't load " + url));
      img.src = url;
    });
  }

  // Each atlas page: {name, width, height} from the .atlas text. A page
  // starts with its file name on a line of its own, followed by
  // "size: w,h"; regions follow, indented or as "name\n  rotate: ...".
  function atlasPages(text) {
    const lines = text.split(/\r?\n/);
    const pages = [];
    for (let i = 0; i < lines.length - 1; i++) {
      const name = lines[i].trim();
      const size = /^\s*size:\s*(\d+)\s*,\s*(\d+)/.exec(lines[i + 1]);
      if (name && /\.png$/i.test(name) && size) pages.push({ name, width: +size[1], height: +size[2] });
    }
    return pages;
  }

  // rawDataURIs for the player: the path it will request for each page ->
  // a URL that actually works (see the header comment).
  async function loadTextures(file, atlasUrl, objectUrls) {
    const res = await fetch(atlasUrl);
    if (!res.ok) throw new Error(`atlas ${res.status}`);
    const pages = atlasPages(await res.text());
    if (!pages.length) throw new Error("atlas has no pages");
    const parent = atlasUrl.slice(0, atlasUrl.lastIndexOf("/"));
    const raw = {};
    await Promise.all(
      pages.map(async (page) => {
        const url = myrtleAssetUrl(`${file.dir}/${page.name}`);
        const img = await loadImage(url);
        let src = url;
        if (img.naturalWidth !== page.width || img.naturalHeight !== page.height) {
          const canvas = document.createElement("canvas");
          canvas.width = page.width;
          canvas.height = page.height;
          canvas.getContext("2d").drawImage(img, 0, 0, page.width, page.height);
          const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
          src = URL.createObjectURL(blob);
          objectUrls.push(src);
        }
        raw[`${parent}/${page.name}`] = src;
      })
    );
    return raw;
  }

  // The panel: view buttons, animation picker, and the stage the player
  // draws into. One instance, reused for every outfit opened.
  function create(container) {
    container.classList.add("chibiPanel");
    container.innerHTML = "";
    const heading = document.createElement("div");
    heading.className = "chibiHeading";
    heading.textContent = "Chibi";
    const controls = document.createElement("div");
    controls.className = "chibiControls";
    const viewButtons = {};
    for (const v of VIEWS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "opStatsViewBtn chibiViewBtn";
      b.textContent = v.label;
      b.addEventListener("click", () => selectView(v.key));
      viewButtons[v.key] = b;
      controls.appendChild(b);
    }
    const animSelect = document.createElement("select");
    animSelect.className = "chibiAnimSelect";
    animSelect.setAttribute("aria-label", "Animation");
    animSelect.addEventListener("change", () => {
      if (player && animSelect.value) player.setAnimation(animSelect.value, true);
    });
    controls.appendChild(animSelect);
    const stage = document.createElement("div");
    stage.className = "chibiStage";
    const status = document.createElement("div");
    status.className = "chibiStatus";
    container.append(heading, controls, stage, status);

    let skin = null;
    let files = null;
    let player = null;
    let objectUrls = [];
    let token = 0; // bumps on every load, so a slow one can't land late
    let failedViews = new Set();
    let currentView = "base";

    function disposePlayer() {
      if (player) {
        player.stopRequestAnimationFrame = true;
        const gl = player.context && player.context.gl;
        const lose = gl && gl.getExtension("WEBGL_lose_context");
        if (lose) lose.loseContext();
        player = null;
      }
      stage.innerHTML = "";
      for (const u of objectUrls) URL.revokeObjectURL(u);
      objectUrls = [];
    }

    function setStatus(text) {
      status.textContent = text || "";
    }

    function updateButtons() {
      for (const v of VIEWS) {
        viewButtons[v.key].classList.toggle("opStatsViewBtnActive", v.key === currentView);
        viewButtons[v.key].disabled = failedViews.has(v.key);
      }
    }

    function fillAnimations(names, view) {
      animSelect.innerHTML = "";
      const preferred = VIEWS.find((v) => v.key === view).animations;
      // The game's own animations first, in a sensible order, then any
      // others the model has (some have extras like "Attack_2"); "Default"
      // is the static setup pose, not an animation.
      const ordered = [...preferred.filter((n) => names.includes(n)), ...names.filter((n) => !preferred.includes(n) && n !== "Default")];
      for (const n of ordered) {
        const o = document.createElement("option");
        o.value = n;
        o.textContent = n.replace(/_/g, " ");
        animSelect.appendChild(o);
      }
      animSelect.disabled = ordered.length < 2;
      return ordered[0];
    }

    async function selectView(view) {
      if (!skin || failedViews.has(view)) return;
      currentView = view;
      updateButtons();
      const my = ++token;
      disposePlayer();
      animSelect.innerHTML = "";
      animSelect.disabled = true;
      stage.classList.add("chibiStageLoading");
      setStatus("Loading…");
      try {
        const spine = await loadRuntime();
        const file = files[view];
        const atlasUrl = fileUrl(file, "atlas");
        const pageObjectUrls = [];
        const raw = await loadTextures(file, atlasUrl, pageObjectUrls);
        if (my !== token) {
          pageObjectUrls.forEach((u) => URL.revokeObjectURL(u));
          return;
        }
        objectUrls = pageObjectUrls;
        const host = document.createElement("div");
        host.className = "chibiPlayerHost";
        stage.appendChild(host);
        await new Promise((resolve, reject) => {
          const p = new spine.SpinePlayer(host, {
            skelUrl: fileUrl(file, "skel"),
            atlasUrl,
            rawDataURIs: raw,
            showControls: false,
            alpha: true,
            backgroundColor: "#00000000",
            // The textures are premultiplied (checked: colour channels stay
            // at or below alpha in semi-transparent pixels).
            premultipliedAlpha: true,
            success: (pl) => resolve(pl),
            error: (pl, msg) => reject(new Error(msg)),
          });
          player = p;
        });
        if (my !== token) return;
        const first = fillAnimations(
          player.skeleton.data.animations.map((a) => a.name),
          view
        );
        if (first) player.setAnimation(first, true);
        stage.classList.remove("chibiStageLoading");
        setStatus("");
      } catch (err) {
        if (my !== token) return;
        console.warn(`No ${view} chibi for ${skin.skinId}:`, err);
        disposePlayer();
        failedViews.add(view);
        updateButtons();
        // Fall through to the next view that might work; if none do, the
        // panel hides itself.
        const next = VIEWS.find((v) => !failedViews.has(v.key));
        if (next) selectView(next.key);
        else {
          stage.classList.remove("chibiStageLoading");
          setStatus("");
          container.classList.add("hidden");
        }
      }
    }

    return {
      show(newSkin) {
        skin = newSkin;
        files = chibiFiles(newSkin);
        failedViews = new Set();
        container.classList.remove("hidden");
        selectView("base");
      },
      // Called when the preview closes: stop drawing and free the WebGL
      // context (browsers only allow a handful at once).
      clear() {
        token++;
        skin = null;
        disposePlayer();
        setStatus("");
      },
    };
  }

  return { create, chibiFiles, atlasPages };
})();
