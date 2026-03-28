// ==UserScript==
// @name         通用图片提取
// @namespace    http://tampermonkey.net/
// @source       https://github.com/qRuWGQ/Tampermonkey
// @downloadURL  https://raw.githubusercontent.com/qRuWGQ/Tampermonkey/refs/heads/main/%E7%BD%91%E7%AB%99%E5%9B%BE%E7%89%87%E6%8F%90%E5%8F%96.js
// @version      1.0.4
// @description  提取页面图片，支持自动/手动提取、分辨率显示、大图预览、去重、单图/ZIP下载，复制源链接/中转链接。
// @author       扫地小厮
// @match        *://*/*
// @require      https://unpkg.com/jszip@3.7.1/dist/jszip.min.js
// @require      https://unpkg.com/file-saver@2.0.5/dist/FileSaver.min.js
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      *
// ==/UserScript==

(function () {
  "use strict";

  // 防止在同一页面重复执行
  if (document.getElementById("ie-overlay")) return;

  // --- 配置与常量 ---
  const CFG = { workerUrl: "https://imags.oror.cc", fab: true };
  const PRESETS = [
    { name: "通用 (Img标签)", match: "ALL", sel: "img" },
    {
      name: "通用 (链接/A标签)",
      match: "ALL",
      sel: "a[href*='.jpg'], a[href*='.png'], a[href*='.webp']",
      attr: "href",
    },
    {
      name: "小红书文章/图文",
      match: /xiaohongshu\.com\/explore\/[a-z\d]+\?/,
      sel: ".swiper-slide img",
    },
    {
      name: "香奈儿-商品页-主图",
      match: /chanel\.com/,
      sel: "#main > div > div.cc-pdp__spaced-elements > div:nth-child(1) > div.grid > ul li img",
    },
    {
      name: "知乎文章",
      match: /^https:\/\/(?:www\.zhihu\.com\/question\/\d+|zhuanlan\.zhihu\.com\/p\/\d+)$/,
      sel: "#content",
    },
    { name: "pexels", match: /pexels\.com/, sel: "#\\- article a[download]", attr: "href" },
    {
      name: "微购相册",
      match: /szwego\.com\/static\/index\.html/,
      sel: ".index-module_grid_item_tgFT- img",
      attr: "",
    },
    {
      name: "CK",
      match: /charleskeith\.com/,
      sel: "div.swiper-slide > picture > img",
    },
    {
      name: "nike",
      match: /nike\.com/,
      sel: ".css-6loeq5 img",
    }
  ];

  // --- 工具函数 ---
  const $ = (s, p = document) => p.querySelector(s);
  const $$ = (s, p = document) => [...p.querySelectorAll(s)];
  const el = (tag, attrs = {}, ...children) => {
    const e = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => {
      if (k.startsWith("on")) e.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "style") Object.assign(e.style, v);
      else if (k === "html") e.innerHTML = v;
      else if (k === "text") e.innerText = v;
      else if (k.startsWith("data-") || k.startsWith("aria-")) e.setAttribute(k, String(v));
      else e[k] = v;
    });
    children.forEach((c) => c && e.appendChild(c instanceof Node ? c : document.createTextNode(c)));
    return e;
  };

  /**
   * 剥离CDN图片处理参数，还原原图URL
   * 支持：七牛(imageMogr2/imageView2)、阿里云OSS(x-oss-process)、又拍云(!/)、腾讯云(imageMogr2)
   */
  const cleanImageUrl = (url) => {
    if (!url || url.startsWith("blob:") || url.startsWith("data:")) return url;
    try {
      const u = new URL(url);

      // 七牛云 / 腾讯云万象：?imageMogr2/... 或 ?imageView2/...
      // 这类URL的 search 部分以 ? 开头后直接是处理指令（无 key=value 结构）
      if (/\?(imageMogr2|imageView2|watermark)\//i.test(url)) {
        return u.origin + u.pathname;
      }

      // 阿里云OSS：?x-oss-process=image/resize,...
      if (u.searchParams.has("x-oss-process")) {
        u.searchParams.delete("x-oss-process");
        return u.toString();
      }

      // 又拍云：!/format/webp/quality/80 等路径式参数
      // 通常追加在路径末尾，如 /xxx.jpg!/thumbnail/320x320
      const bangIdx = u.pathname.indexOf("!/");
      if (bangIdx !== -1) {
        u.pathname = u.pathname.slice(0, bangIdx);
        return u.toString();
      }

      // 通用：URL含常见缩略参数（thumbnail, resize, width, w, h, quality, format, crop）
      // 且路径末段是图片扩展名时，尝试去除所有查询参数
      const hasImageExt = /\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(u.pathname);
      const hasThumbnailParams = /(thumbnail|resize|width|quality|format|imageSlim|imageslim)/i.test(u.search);
      if (hasImageExt && hasThumbnailParams) {
        return u.origin + u.pathname;
      }

      return url;
    } catch {
      return url;
    }
  };

  // 增强的 Fetch Blob，支持相对路径检查
  const fetchBlob = (url, timeout = 30000) =>
    new Promise((resolve, reject) => {
      // 验证URL格式
      try {
        new URL(url);
      } catch (e) {
        reject(new Error(`无效的URL格式: ${url}`));
        return;
      }

      // 如果是 blob: 协议，直接用 fetch，不用 GM_xmlhttpRequest
      if (url.startsWith("blob:")) {
        fetch(url)
          .then((r) => {
            if (!r.ok) {
              throw new Error(`HTTP ${r.status}: ${r.statusText}`);
            }
            return r.blob();
          })
          .then((blob) => {
            if (blob.size === 0) {
              throw new Error("图片文件为空");
            }
            const type = blob.type.split("/")[1] || "jpg";
            resolve({ blob, type });
          })
          .catch((error) => {
            reject(new Error(`Blob获取失败: ${error.message}`));
          });
        return;
      }

      // 限制最大文件大小 (50MB)
      const MAX_FILE_SIZE = 50 * 1024 * 1024;

      GM_xmlhttpRequest({
        method: "GET",
        url,
        responseType: "blob",
        timeout,
        onload: (r) => {
          if (r.status === 200) {
            if (r.response.size > MAX_FILE_SIZE) {
              reject(new Error(`文件过大: ${r.response.size} bytes (最大限制: ${MAX_FILE_SIZE} bytes)`));
              return;
            }
            const type = r.responseHeaders.match(/content-type:\s*image\/(\w+)/i)?.[1] || "jpg";
            resolve({ blob: r.response, type });
          } else if (r.status >= 400 && r.status < 500) {
            reject(new Error(`客户端错误 ${r.status}: 请求被拒绝或资源不存在`));
          } else if (r.status >= 500) {
            reject(new Error(`服务器错误 ${r.status}: 服务器暂时不可用`));
          } else {
            reject(new Error(`网络错误 ${r.status}: ${r.statusText || "未知错误"}`));
          }
        },
        onerror: (error) => {
          reject(new Error(`网络请求失败: ${error?.details || error?.message || "连接错误"}`));
        },
        ontimeout: () => {
          reject(new Error("请求超时，请检查网络连接"));
        },
      });
    });

  const getFileName = (url, ext, idx) => {
    // 统一序号命名：image01, image02, ...
    const num = String(idx + 1).padStart(2, "0");
    return `image${num}.${ext}`;
  };

  const getExtFromUrl = (url) => {
    const match = url.match(/\.(jpg|jpeg|png|webp|gif|bmp)$/i);
    return match ? match[1].toLowerCase() : "jpg";
  };

  const getProxyUrl = (src) => {
    const ext = getExtFromUrl(src);
    const randName = `img_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const bsrc = btoa(src);
    const bref = btoa(location.href);
    return `${CFG.workerUrl}/${randName}.${ext}?src=${bsrc}&ref=${bref}`;
  };

  // --- 样式 ---
  GM_addStyle(`
        #ie-overlay { position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:2147483645!important;display:none;justify-content:center;align-items:center;font-family:sans-serif; }
        #ie-modal { background:#fff;width:90%;max-width:1100px;height:85vh;border-radius:12px;display:flex;flex-direction:column;box-shadow:0 10px 25px rgba(0,0,0,0.5);overflow:hidden; }
        .ie-head { padding:15px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;background:#f8f9fa;gap:10px; }
        .ie-ctrl { display:flex;gap:8px;align-items:center;flex-wrap:wrap;flex:1;justify-content:flex-end; }
        .ie-inp { padding:6px;border:1px solid #ddd;border-radius:4px;font-size:13px; }
        .ie-btn { padding:6px 12px;border:none;border-radius:4px;cursor:pointer;color:#fff;font-size:13px;white-space:nowrap; }
        .ie-btn:disabled { opacity:0.6;cursor:not-allowed; }
        .b-blue { background:#007bff; } .b-blue:hover { background:#0056b3; }
        .b-green { background:#28a745; } .b-green:hover { background:#218838; }
        .b-red { background:#dc3545; } .b-red:hover { background:#c82333; }
        .b-yel { background:#ffc107;color:#333; } .b-yel:hover { background:#e0a800; }
        .ie-body { flex:1;overflow-y:auto;padding:15px;background:#f0f2f5; }
        .ie-grid { display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px; }
        .ie-card { background:#fff;border-radius:6px;box-shadow:0 2px 4px rgba(0,0,0,0.05);overflow:hidden;border:2px solid transparent;cursor:pointer;transition:0.2s;position:relative; }
        .ie-card.sel { border-color:#007bff;background:#e8f0fe; }
        .ie-thumb-box { height:150px;position:relative;background:#eee;display:flex;align-items:center;justify-content:center;overflow:hidden;background-image: linear-gradient(45deg, #ccc 25%, transparent 25%), linear-gradient(-45deg, #ccc 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #ccc 75%), linear-gradient(-45deg, transparent 75%, #ccc 75%); background-size: 20px 20px; }
        .ie-thumb { max-width:100%;max-height:100%;object-fit:contain; }
        .ie-res { position:absolute;bottom:0;right:0;background:rgba(0,0,0,0.6);color:#fff;font-size:10px;padding:2px 6px;border-radius:4px 0 0 0;pointer-events:none; }
        .ie-ck { position:absolute;top:6px;right:6px;width:18px;height:18px;accent-color:#007bff;cursor:pointer; }
        .ie-meta { padding:6px;font-size:11px;color:#666;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;height:26px;line-height:14px; }
        .ie-acts { display:flex;border-top:1px solid #eee; }
        .ie-act { flex:1;border:none;background:#f9f9f9;cursor:pointer;padding:6px;font-size:14px;transition:0.2s; }
        .ie-act:hover { background:#e9ecef; } .ie-act:active { background:#dee2e6; }
        .ie-foot { padding:12px 20px;border-top:1px solid #eee;background:#fff;display:flex;justify-content:space-between;align-items:center; }
        .ie-status { font-size:12px; color:#666; margin-right:auto; padding-right:15px; border-right:1px solid #eee; }
        #ie-fab { position:fixed;width:50px;height:50px;background:#007bff;border-radius:50%;color:#fff;display:flex;justify-content:center;align-items:center;box-shadow:0 4px 15px rgba(0,0,0,0.3);cursor:grab;z-index:2147483644!important;font-size:24px;border:2px solid #fff;bottom:30px;right:30px;user-select:none;transition: transform 0.1s; }
        #ie-fab:active { transform: scale(0.95); cursor: grabbing; }
        #ie-preview { position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.9);z-index:2147483646!important;display:none;justify-content:center;align-items:center;flex-direction:column; }
        #ie-p-img { max-width:90%;max-height:90%;object-fit:contain;box-shadow:0 0 20px rgba(255,255,255,0.2);background:#1a1a1a; }
        .ie-hover { outline:3px solid #ff4757!important;box-shadow:inset 0 0 0 1000px rgba(255,71,87,0.05)!important; }
        #ie-tip { position:fixed;top:20px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.8);color:#fff;padding:10px 20px;border-radius:20px;z-index:2147483647!important;display:none;pointer-events:none; }
    `);

  // --- UI 构建 ---
  const app = el(
    "div",
    { id: "ie-overlay" },
    el(
      "div",
      { id: "ie-modal" },
      el(
        "div",
        { className: "ie-head" },
        el("div", {
          className: "ie-title",
          text: "图片提取 1.2",
          style: { fontWeight: "bold", fontSize: "18px" },
        }),
        el(
          "div",
          { className: "ie-ctrl" },
          el("button", { className: "ie-btn b-yel", text: "👆 选取元素", onclick: startPick }),
          el(
            "select",
            {
              className: "ie-inp",
              id: "ie-sel",
              style: { maxWidth: "120px" },
              onchange: (e) => {
                if (e.target.value != "-1") {
                  const p = PRESETS[e.target.value];
                  $("#ie-css").value = p.sel;
                  $("#ie-attr").value = p.attr || "";
                  runExtract();
                }
              },
            },
            ...PRESETS.map((p, i) => el("option", { value: i, text: p.name })),
            el("option", { value: "-1", text: "自定义" }),
          ),
          el("input", {
            type: "text",
            id: "ie-css",
            className: "ie-inp",
            placeholder: "CSS选择器",
            style: { width: "180px" },
            oninput: () => ($("#ie-sel").value = "-1"),
          }),
          el("input", {
            type: "text",
            id: "ie-attr",
            className: "ie-inp",
            placeholder: "属性(如href)",
            title: "不填则自动识别",
            style: { width: "80px" },
          }),
          el("button", {
            className: "ie-btn",
            text: "🔍 提取",
            style: { border: "1px solid #ccc", color: "#333" },
            onclick: runExtract,
          }),
          el("button", {
            className: "ie-btn b-red",
            text: "关闭",
            onclick: () => (app.style.display = "none"),
          }),
        ),
      ),
      el("div", { className: "ie-body" }, el("div", { id: "ie-grid", className: "ie-grid" })),
      el(
        "div",
        { className: "ie-foot" },
        el("div", { className: "ie-status", id: "ie-status-text", html: "就绪" }),
        el(
          "div",
          {
            style: {
              display: "flex",
              gap: "10px",
              alignItems: "center",
              fontSize: "14px",
              flex: "1",
            },
          },
          el("span", { html: '已选 <b id="ie-num" style="color:#007bff">0</b> 张' }),
          el("a", {
            text: "全选",
            style: { cursor: "pointer", color: "#007bff" },
            onclick: () => setAll(true),
          }),
          el("a", {
            text: "清空",
            style: { cursor: "pointer", color: "#666" },
            onclick: () => setAll(false),
          }),
          el("button", {
            className: "ie-btn b-yel",
            id: "ie-dedup",
            text: "🧹 去重",
            onclick: deduplicate,
          }),
        ),
        el(
          "div",
          { style: { display: "flex", gap: "10px" } },
          el(
            "select",
            {
              id: "ie-copy-mode",
              className: "ie-inp",
              style: { padding: "6px 8px", minWidth: "70px", fontSize: "13px" },
            },
            el("option", { value: "original", selected: true, text: "源链接" }),
            el("option", { value: "proxy", text: "中转" }),
          ),
          el("button", { className: "ie-btn b-blue", text: "📋 复制链接", onclick: copyLinks }),
          el("button", {
            className: "ie-btn b-green",
            id: "ie-dl-zip",
            text: "📦 下载压缩包",
            onclick: dlZip,
          }),
        ),
      ),
    ),
  );

  const preview = el(
    "div",
    {
      id: "ie-preview",
      onclick: (e) => {
        if (e.target.id === "ie-preview") preview.style.display = "none";
      },
    },
    el("img", { id: "ie-p-img", src: "" }),
    el("div", {
      id: "ie-p-inf",
      style: {
        color: "#ccc",
        marginTop: "10px",
        fontFamily: "monospace",
        background: "rgba(0,0,0,0.5)",
        padding: "4px 10px",
        borderRadius: "4px",
      },
    }),
  );
  const tip = el("div", {
    id: "ie-tip",
    html: "移动选择 / <b>W</b> 扩大选中 / <b>S</b> 缩小选中 / <b>点击</b> 确认 / <b>ESC</b> 退出",
  });

  // 确保 body 存在后再添加 UI
  if (document.body) {
    if (!document.getElementById("ie-overlay")) document.body.append(app, preview, tip);
  } else {
    document.addEventListener("DOMContentLoaded", () => {
      if (!document.getElementById("ie-overlay")) document.body.append(app, preview, tip);
    });
  }

  const imgObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const img = entry.target;
          const src = img.dataset.src;
          if (src) {
            img.src = src;
            delete img.dataset.src;
            imgObserver.unobserve(img);
          }
        }
      });
    },
    { root: null, threshold: 0, rootMargin: "0px 0px 200px 0px" },
  );

  // --- 核心逻辑 ---
  let images = [],
    isPicking = false,
    curHigh = null;

  // 悬浮图标仅在顶层窗口显示，且防止重复创建
  if (CFG.fab && window.self === window.top) {
    if (document.getElementById("ie-fab")) return;
    const pos = JSON.parse(localStorage.getItem("ie_pos") || '{"bottom":"30px","right":"30px"}');
    const fab = el("div", { id: "ie-fab", html: "📷", title: "提取图片", style: pos });
    let isDrag = false,
      isPressed = false,
      sx,
      sy;
    fab.onmousedown = (e) => {
      isPressed = true;
      isDrag = false;
      sx = e.clientX;
      sy = e.clientY;
      e.preventDefault();
    };
    document.addEventListener("mousemove", (e) => {
      if (!isPressed || e.buttons !== 1) return;
      if (Math.abs(e.clientX - sx) > 5 || Math.abs(e.clientY - sy) > 5) isDrag = true;
      if (isDrag) {
        fab.style.left = Math.min(window.innerWidth - 50, Math.max(0, e.clientX - 25)) + "px";
        fab.style.top = Math.min(window.innerHeight - 50, Math.max(0, e.clientY - 25)) + "px";
        fab.style.bottom = "auto";
        fab.style.right = "auto";
      }
    });
    document.addEventListener("mouseup", () => {
      if (isPressed && isDrag) localStorage.setItem("ie_pos", JSON.stringify({ left: fab.style.left, top: fab.style.top }));
      isPressed = false;
    });
    fab.onclick = () => !isDrag && openMain();
    if (document.body) {
      if (!document.getElementById("ie-fab")) document.body.appendChild(fab);
    } else {
      document.addEventListener("DOMContentLoaded", () => {
        if (!document.getElementById("ie-fab")) document.body.appendChild(fab);
      });
    }
  }

  function openMain() {
    app.style.display = "flex";
    let url = location.href;
    let idx = PRESETS.findIndex((p) => p.match instanceof RegExp && p.match.test(url));
    if (idx === -1) idx = 0;
    $("#ie-sel").value = idx;
    $("#ie-css").value = PRESETS[idx].sel;
    $("#ie-attr").value = PRESETS[idx].attr || "";
    runExtract();
  }

  // --- 核心提取逻辑 ---
  function runExtract() {
    const sel = $("#ie-css").value;
    const targetAttr = $("#ie-attr").value.trim();
    const statusEl = $("#ie-status-text");

    if (!sel) return;

    const seen = new Set();
    images = [];
    let matchedCount = 0;

    try {
      const selTrim = sel.trim();
      const parts = selTrim.split(/\s+/);
      const lastPart = parts[parts.length - 1]?.toLowerCase() || "";
      let elementsSet = new Set();
      $$(selTrim).forEach((el) => elementsSet.add(el));
      if (lastPart !== "img") {
        const imgSel = selTrim + " img";
        $$(imgSel).forEach((el) => elementsSet.add(el));
      }
      const elements = Array.from(elementsSet);
      matchedCount = elements.length;

      elements.forEach((el) => {
        let src = null;

        // 1. 指定属性
        if (targetAttr) {
          if (targetAttr === "style") {
            const bg = getComputedStyle(el).backgroundImage;
            if (bg && bg !== "none") src = bg.slice(4, -1).replace(/["']/g, "");
          } else {
            // 特殊处理 href，直接访问 property 获取绝对路径，getAttribute 可能是相对路径
            src = targetAttr === "href" ? el.href : el.getAttribute(targetAttr);
          }
        }
        // 2. 自动识别
        else {
          if (el.tagName === "A") src = el.href;
          else if (el.tagName === "IMG") {
            const candidates = ["data-src-high", "data-original", "data-lazy-src", "data-src", "data-url", "src"];
            for (let attr of candidates) {
              const val = el.getAttribute(attr) || el[attr];
              if (val && !val.includes("placeholder")) {
                src = val;
                break;
              }
            }
            if (!src) src = el.src;
          } else {
            const bg = getComputedStyle(el).backgroundImage;
            if (bg && bg !== "none") src = bg.slice(4, -1).replace(/["']/g, "");
          }
        }

        // 3. 路径补全与校验
        if (src) {
          if (!src.startsWith("http") && !src.startsWith("blob:") && !src.startsWith("data:")) {
            src = new URL(src, location.origin).href;
          }

          // ★ 新增：剥离CDN图片处理参数，还原原图URL
          src = cleanImageUrl(src);

          const isHttp = src.startsWith("http");
          const isBlob = src.startsWith("blob:");
          const isData = src.startsWith("data:image");

          if ((isHttp || isBlob || isData) && !seen.has(src)) {
            seen.add(src);
            images.push({ src, sel: true, ext: "jpg" });
          }
        }
      });
      statusEl.innerText = `匹配: ${matchedCount} | 有效: ${images.length}`;
      statusEl.style.color = images.length > 0 ? "#28a745" : "#dc3545";
    } catch (e) {
      console.error(e);
      statusEl.innerText = `选择器错误: ${e.message}`;
      statusEl.style.color = "#dc3545";
    }
    render();
  }

  function render() {
    const grid = $("#ie-grid");
    grid.innerHTML = "";
    if (!images.length)
      return (grid.innerHTML = '<div style="text-align:center;padding:40px;color:#999;grid-column:1/-1">⚠️ 未找到有效图片链接<br><small>请检查选择器是否正确，或尝试指定属性 (如 href)</small></div>');

    const frag = document.createDocumentFragment();
    images.forEach((item, idx) => {
      const resTag = el("div", { className: "ie-res", text: "...", style: { display: "none" } });

      const imgEl = el("img", {
        className: "ie-thumb",
        "data-src": item.src,
        src: "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTYwIiBoZWlnaHQ9IjE1MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSIjZWVlIi8+PHRleHQgeD0iNTAlIiB5PSI1NSUiIGZvbnQtZmFtaWx5PSJzYW5zLXNlcmlmIiBmb250LXNpemU9IjE0IiBmaWxsPSIjY2NjIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBkeT0iLjNlbSI+dG9vdGxlPC90ZXh0Pjwvc3ZnPg==",
        onload: function () {
          resTag.innerText = `${this.naturalWidth}x${this.naturalHeight}`;
          resTag.style.display = "block";
          item.size = `${this.naturalWidth}x${this.naturalHeight}`;
        },
        onerror: function () {
          console.error("Thumb onerror:", this.src);
          this.style.display = "none";
          // 如果缩略图加载失败（可能是非图片链接），显示一个文件图标
          this.parentElement.appendChild(el("div", { style: { fontSize: "30px", color: "#666" }, text: "📄" }));
        },
      });

      const card = el(
        "div",
        {
          className: `ie-card ${item.sel ? "sel" : ""}`,
          onclick: (e) => {
            if (!e.target.closest(".ie-act") && !e.target.closest(".ie-ck")) {
              item.sel = !item.sel;
              render();
            }
          },
        },
        el(
          "div",
          { className: "ie-thumb-box" },
          imgEl,
          resTag,
          el("input", {
            type: "checkbox",
            className: "ie-ck",
            checked: item.sel,
            onclick: (e) => {
              item.sel = e.target.checked;
              e.stopPropagation();
            },
          }),
        ),
        el("div", {
          className: "ie-meta",
          text: getFileName(item.src, "jpg", idx),
          title: item.src,
        }),
        el(
          "div",
          { className: "ie-acts" },
          el("button", {
            className: "ie-act",
            html: "👁️",
            title: "预览",
            onclick: (e) => {
              e.stopPropagation();
              showPreview(item.src);
            },
          }),
          el("button", {
            className: "ie-act",
            html: "📥",
            title: "下载",
            onclick: function (e) {
              e.stopPropagation();
              dlOne(item, idx, this);
            },
          }),
          el("button", {
            className: "ie-act",
            html: "🔗",
            title: "复制",
            style: { color: "#dc3545" },
            onclick: (e) => {
              e.stopPropagation();
              copyOne(item, idx);
            },
          }),
        ),
      );
      frag.appendChild(card);
    });
    grid.appendChild(frag);
    $$(".ie-thumb", grid).forEach((img) => {
      imgObserver.observe(img);
    });
    $("#ie-num").innerText = images.filter((i) => i.sel).length;
  }

  // --- 功能模块 ---
  function setAll(val) {
    images.forEach((i) => (i.sel = val));
    render();
  }

  function deduplicate() {
    const keyMap = new Map();
    let cnt = 0;
    images.forEach((i) => {
      if (!i.sel) return;
      const base = i.src
        .replace(/^http:/, "https:")
        .split("?")[0]
        .toLowerCase();
      const size = i.size || "0x0";
      const key = `${base}|${size}`;
      if (keyMap.has(key)) {
        i.sel = false;
        cnt++;
      } else {
        keyMap.set(key, true);
      }
    });
    render();
    const btn = $("#ie-dedup");
    btn.innerText = `过滤 ${cnt}`;
    setTimeout(() => (btn.innerText = "🧹 去重"), 1500);
  }

  function showPreview(src) {
    preview.style.display = "flex";
    const img = $("#ie-p-img");
    const infoEl = $("#ie-p-inf");

    try {
      // 验证URL格式
      new URL(src);

      img.src = "";
      img.src = src;
      infoEl.innerText = "Loading...";

      img.onload = function () {
        infoEl.innerText = `${this.naturalWidth} x ${this.naturalHeight} px`;
      };

      img.onerror = function () {
        console.error("预览加载失败:", src);
        infoEl.innerText = "预览不可用 (可能是下载链接或无效图片)";
        infoEl.style.color = "#dc3545"; // 红色表示错误

        // 可选：显示一个占位符图标
        img.src =
          "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSIjZWVlIi8+PHRleHQgeD0iNTAlIiB5PSI1MCUiIGZvbnQtZmFtaWx5PSJzYW5zLXNlcmlmIiBmb250LXNpemU9IjE2IiBmaWxsPSIjY2NjIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBkeT0iMjVweCI+44CC44CC44CCPC90ZXh0Pjx0ZXh0IHg9IjUwJSIgeT0iNTAlIiBmb250LWZhbWlseT0ic2Fucy1zZXJpZiIgZm9udC1zaXplPSIxMiIgZmlsbD0iI2NjYyIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZHk9IjUwcHgiPvOAi+OAi+OAizwvdGV4dD48L3N2Zz4=";
      };
    } catch (e) {
      console.error("无效的预览URL:", e);
      infoEl.innerText = `预览失败: ${e.message}`;
      infoEl.style.color = "#dc3545";
    }
  }

  async function dlOne(item, idx, btn) {
    if (btn.disabled) return;
    const old = btn.innerHTML;
    btn.innerHTML = "⏳";
    btn.disabled = true;

    try {
      const { blob, type } = await fetchBlob(item.src);
      saveAs(blob, getFileName(item.src, type === "jpeg" ? "jpg" : type, idx));
      btn.innerHTML = "✅";

      // 显示成功提示
      const statusEl = $("#ie-status-text");
      statusEl.innerText = `下载成功: ${getFileName(item.src, type === "jpeg" ? "jpg" : type, idx)}`;
      statusEl.style.color = "#28a745";
    } catch (e) {
      console.error("图片下载失败:", e);
      btn.innerHTML = "❌";
      btn.style.background = "#ffebeb";

      // 显示错误信息到状态栏
      const statusEl = $("#ie-status-text");
      statusEl.innerText = `下载失败: ${e.message}`;
      statusEl.style.color = "#dc3545";
    }

    setTimeout(() => {
      btn.innerHTML = old;
      btn.disabled = false;
      btn.style.background = "";
    }, 2000);
  }

async function dlZip() {
    const sels = images.filter((i) => i.sel);
    if (!sels.length) {
      alert("请先选择图片");
      return;
    }

    const btn = $("#ie-dl-zip");
    const old = btn.innerText;
    btn.innerText = "准备中...";
    btn.disabled = true;

    try {
      const zip = new JSZip();
      const folder = zip.folder("images");
      let done = 0;
      let fail = 0;
      const limit = 5;
      const errors = [];
      const usedNames = new Set(); // ★ 文件名注册表，防止 JSZip 静默覆写

      // ★ 辅助函数：确保 ZIP 内文件名唯一
      const resolveUniqueName = (fileName) => {
        if (!usedNames.has(fileName)) {
          usedNames.add(fileName);
          return fileName;
        }
        // 极端兜底：序号+时间戳
        const lastDot = fileName.lastIndexOf(".");
        const base = lastDot !== -1 ? fileName.slice(0, lastDot) : fileName;
        const extension = lastDot !== -1 ? fileName.slice(lastDot) : ".jpg";
        let i = 1;
        let candidate;
        do {
          candidate = `${base}_${i}${extension}`;
          i++;
        } while (usedNames.has(candidate));
        usedNames.add(candidate);
        return candidate;
      };

      for (let i = 0; i < sels.length; i += limit) {
        const chunk = sels.slice(i, i + limit);
        await Promise.all(
          chunk.map((item, subIdx) => {
            const globalIdx = i + subIdx; // ★ 捕获全局索引（避免闭包变量污染）
            return fetchBlob(item.src)
              .then(({ blob, type }) => {
                const ext = type === "jpeg" ? "jpg" : type;
                const rawName = getFileName(item.src, ext, globalIdx);
                const fileName = resolveUniqueName(rawName, globalIdx, ext); // ★ 唯一化
                folder.file(fileName, blob);
                done++;
              })
              .catch((error) => {
                fail++;
                errors.push({ url: item.src, error: error.message });
                console.error(`下载失败 [${item.src}]:`, error.message);
              })
              .finally(() => (btn.innerText = `下载中 ${done + fail}/${sels.length}`));
          }),
        );
      }

      if (done > 0) {
        btn.innerText = "打包中...";
        const zipBlob = await zip.generateAsync({ type: "blob" });
        saveAs(zipBlob, `Images_${document.title}_${Date.now()}.zip`);

        const statusEl = $("#ie-status-text");
        if (fail > 0) {
          statusEl.innerText = `下载完成: ${done} 成功, ${fail} 失败`;
          statusEl.style.color = "#ffc107";
          if (errors.length > 0) console.log("下载失败的图片:", errors);
        } else {
          statusEl.innerText = `ZIP下载成功: ${done} 个文件`;
          statusEl.style.color = "#28a745";
        }
      } else {
        throw new Error("所有图片下载都失败了");
      }
    } catch (e) {
      console.error("ZIP下载失败:", e);
      const statusEl = $("#ie-status-text");
      statusEl.innerText = `ZIP下载失败: ${e.message}`;
      statusEl.style.color = "#dc3545";
      alert(`ZIP下载失败: ${e.message}`);
    } finally {
      btn.innerText = old;
      btn.disabled = false;
    }
  }

  function copyOne(item, idx) {
    const mode = $("#ie-copy-mode").value || "original";
    const link = mode === "proxy" ? getProxyUrl(item.src) : item.src;

    navigator.clipboard
      .writeText(link)
      .then(() => {
        const tip = $("#ie-tip");
        tip.innerText = `${mode === "proxy" ? "中转" : "源"}链接已复制`;
        tip.style.display = "block";
        setTimeout(() => (tip.style.display = "none"), 1000);
      })
      .catch((error) => {
        console.error("复制链接失败:", error);
        const statusEl = $("#ie-status-text");
        statusEl.innerText = `复制失败: ${error.message}`;
        statusEl.style.color = "#dc3545";

        // 降级方案：使用execCommand
        try {
          const textArea = document.createElement("textarea");
          textArea.value = link;
          document.body.appendChild(textArea);
          textArea.select();
          document.execCommand("copy");
          document.body.removeChild(textArea);

          const tip = $("#ie-tip");
          tip.innerText = `${mode === "proxy" ? "中转" : "源"}链接已复制 (降级方案)`;
          tip.style.display = "block";
          setTimeout(() => (tip.style.display = "none"), 1000);
        } catch (fallbackError) {
          console.error("降级复制也失败:", fallbackError);
          alert(`复制链接失败，请手动复制:\n${link}`);
        }
      });
  }

  function copyLinks() {
    const mode = $("#ie-copy-mode").value || "original";
    const links = images.filter((i) => i.sel).map((i) => (mode === "proxy" ? getProxyUrl(i.src) : i.src));
    if (links.length) navigator.clipboard.writeText(links.join("\n")).then(() => alert(`已复制 ${links.length} 条链接`));
  }

  // --- 选取器逻辑 ---
  function startPick() {
    isPicking = true;
    app.style.display = "none";
    tip.innerHTML = "移动选择 / <b>W</b> 扩大选中 / <b>S</b> 缩小 / 点击确认 / <b>ESC</b> 退出";
    tip.style.display = "block";
    document.body.classList.add("ie-picker-on");

    const over = (e) => {
      if (e.target === tip || tip.contains(e.target)) return;
      e.stopPropagation();
      if (curHigh) curHigh.classList.remove("ie-hover");
      (curHigh = e.target).classList.add("ie-hover");
    };
    const down = (e) => {
      if (!isPicking) return;
      e.preventDefault();
      e.stopPropagation();
      const el = curHigh || e.target;
      const cls = `ie-sel-${Date.now()}`;
      el.classList.add(cls);

      $("#ie-sel").value = "-1";
      if (el.tagName === "A") {
        $("#ie-css").value = `.${cls}`;
        $("#ie-attr").value = "href";
      } else if (el.tagName === "IMG") {
        $("#ie-css").value = `.${cls}`;
        $("#ie-attr").value = "";
      } else {
        $("#ie-css").value = `.${cls} img`;
        $("#ie-attr").value = "";
      }

      exitPick();
      runExtract();
    };
    const key = (e) => {
      if (!isPicking) return;
      if (e.key === "Escape") exitPick();
      if ((e.key === "w" || e.key === "ArrowUp") && curHigh?.parentElement) {
        curHigh.classList.remove("ie-hover");
        (curHigh = curHigh.parentElement).classList.add("ie-hover");
      }
      if ((e.key === "s" || e.key === "ArrowDown") && curHigh?.firstElementChild) {
        curHigh.classList.remove("ie-hover");
        (curHigh = curHigh.firstElementChild).classList.add("ie-hover");
      }
    };
    document.addEventListener("mouseover", over);
    document.addEventListener("click", down, true);
    document.addEventListener("keydown", key);
    window._ie_exit = () => {
      isPicking = false;
      app.style.display = "flex";
      tip.style.display = "none";
      if (curHigh) curHigh.classList.remove("ie-hover");
      document.removeEventListener("mouseover", over);
      document.removeEventListener("click", down, true);
      document.removeEventListener("keydown", key);
    };
  }
  function exitPick() {
    window._ie_exit && window._ie_exit();
  }

  GM_registerMenuCommand("📥 提取图片", openMain);
  document.addEventListener("keydown", (e) => {
    if (e.altKey && e.key.toLowerCase() === "i") app.style.display === "flex" ? (app.style.display = "none") : openMain();
    if (e.key === "Escape") preview.style.display = "none";
  });
})();
