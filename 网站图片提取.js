// ==UserScript==
// @name         通用图片提取
// @namespace    http://tampermonkey.net/
// @source       https://github.com/qRuWGQ/Tampermonkey
// @downloadURL  https://raw.githubusercontent.com/qRuWGQ/Tampermonkey/refs/heads/main/%E7%BD%91%E7%AB%99%E5%9B%BE%E7%89%87%E6%8F%90%E5%8F%96.js
// @version      1.2.0
// @description  提取页面图片，支持自动/手动提取、分辨率显示、大图预览、去重、单图/ZIP下载，复制源链接/中转链接，复制图片到剪贴板。Shadow DOM隔离，兼容任意页面。
// @author       扫地小厮
// @match        *://*/*
// @require      https://unpkg.com/jszip@3.7.1/dist/jszip.min.js
// @require      https://unpkg.com/file-saver@2.0.5/dist/FileSaver.min.js
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      *
// ==/UserScript==

(function () {
  "use strict";

  if (document.getElementById("ie-shadow-host")) return;

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
    { name: "CK", match: /charleskeith\.com/, sel: "div.swiper-slide > picture > img" },
    { name: "得物", match: /dewu\.com/, sel: "div.image-small img" },
    { name: "nike中国", match: /nike\.com\.cn/, sel: "#hero-image .css-caclzx img" },
  ];

  const PLACEHOLDER_SVG =
    "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTYwIiBoZWlnaHQ9IjE1MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSIjZjBmMGYwIi8+PC9zdmc+";
  const MAX_FILE_SIZE = 50 * 1024 * 1024;
  const CONCURRENT_LIMIT = 5;

  // --- Shadow DOM 宿主挂载 ---
  const shadowHost = document.createElement("div");
  shadowHost.id = "ie-shadow-host";
  shadowHost.style.cssText =
    [
      "all: initial",
      "position: fixed",
      "top: 0",
      "left: 0",
      "width: 0",
      "height: 0",
      "z-index: 2147483640",
      "pointer-events: none",
    ].join(" !important;") + " !important;";

  const shadowRoot = shadowHost.attachShadow({ mode: "open" });

  // --- 样式注入至 Shadow Root ---
  const styleEl = document.createElement("style");
  styleEl.textContent = `
    *, *::before, *::after {
      box-sizing: border-box !important;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
      line-height: normal !important;
    }
    #ie-overlay {
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0,0,0,0.6); z-index: 2147483645;
      display: none; justify-content: center; align-items: center;
      pointer-events: auto;
    }
    #ie-modal {
      background: #fff; width: 90%; max-width: 1100px; height: 85vh;
      border-radius: 12px; display: flex; flex-direction: column;
      box-shadow: 0 10px 25px rgba(0,0,0,0.5); overflow: hidden;
    }
    .ie-head {
      padding: 15px; border-bottom: 1px solid #eee;
      display: flex; justify-content: space-between; align-items: center;
      background: #f8f9fa; gap: 10px; flex-shrink: 0;
    }
    .ie-ctrl {
      display: flex; gap: 8px; align-items: center;
      flex-wrap: wrap; flex: 1; justify-content: flex-end;
    }
    .ie-inp {
      padding: 6px; border: 1px solid #ddd; border-radius: 4px;
      font-size: 13px; background: #fff; color: #333;
      outline: none; margin: 0;
    }
    .ie-btn {
      padding: 6px 12px; border: none; border-radius: 4px;
      cursor: pointer; color: #fff; font-size: 13px;
      white-space: nowrap; margin: 0; display: inline-flex;
      align-items: center; justify-content: center;
      transition: opacity 0.2s;
    }
    .ie-btn:disabled { opacity: 0.6; cursor: not-allowed; }
    .b-blue { background: #007bff; }
    .b-blue:hover:not(:disabled) { background: #0056b3; }
    .b-green { background: #28a745; }
    .b-green:hover:not(:disabled) { background: #218838; }
    .b-red { background: #dc3545; }
    .b-red:hover:not(:disabled) { background: #c82333; }
    .b-yel { background: #ffc107; color: #333; }
    .b-yel:hover:not(:disabled) { background: #e0a800; }
    .b-purple { background: #6f42c1; }
    .b-purple:hover:not(:disabled) { background: #5a32a3; }
    .ie-body { flex: 1; overflow-y: auto; padding: 15px; background: #f0f2f5; }
    .ie-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
      gap: 12px;
    }
    .ie-card {
      background: #fff; border-radius: 6px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.05); overflow: hidden;
      border: 2px solid transparent; cursor: pointer;
      transition: border-color 0.2s; position: relative;
      display: flex; flex-direction: column;
    }
    .ie-card.sel { border-color: #007bff; background: #e8f0fe; }
    .ie-thumb-box {
      height: 150px; position: relative; background: #eee;
      display: flex; align-items: center; justify-content: center;
      overflow: hidden; flex-shrink: 0;
      background-image: linear-gradient(45deg, #ccc 25%, transparent 25%),
        linear-gradient(-45deg, #ccc 25%, transparent 25%),
        linear-gradient(45deg, transparent 75%, #ccc 75%),
        linear-gradient(-45deg, transparent 75%, #ccc 75%);
      background-size: 20px 20px;
      background-position: 0 0, 0 10px, 10px -10px, -10px 0px;
    }
    .ie-thumb { max-width: 100%; max-height: 100%; object-fit: contain; display: block; }
    .ie-res {
      position: absolute; bottom: 0; right: 0;
      background: rgba(0,0,0,0.6); color: #fff; font-size: 10px;
      padding: 2px 6px; border-radius: 4px 0 0 0; pointer-events: none;
    }
    .ie-ck {
      position: absolute; top: 6px; right: 6px;
      width: 18px; height: 18px; accent-color: #007bff;
      cursor: pointer; margin: 0;
    }
    .ie-meta {
      padding: 6px; font-size: 11px; color: #666; text-align: center;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      height: 26px; line-height: 14px; flex-shrink: 0;
    }
    .ie-acts {
      display: flex; border-top: 1px solid #eee; flex-shrink: 0;
    }
    .ie-act {
      flex: 1; border: none; background: #f9f9f9; cursor: pointer;
      padding: 6px; font-size: 14px; transition: background 0.2s;
      margin: 0; display: inline-flex; align-items: center; justify-content: center;
    }
    .ie-act:hover { background: #e9ecef; }
    .ie-act:active { background: #dee2e6; }
    .ie-act:disabled { opacity: 0.5; cursor: not-allowed; }
    .ie-foot {
      padding: 12px 20px; border-top: 1px solid #eee; background: #fff;
      display: flex; justify-content: space-between; align-items: center;
      flex-shrink: 0; gap: 10px; flex-wrap: wrap;
    }
    .ie-status {
      font-size: 12px; color: #666; margin-right: auto;
      padding-right: 15px; border-right: 1px solid #eee;
      white-space: nowrap;
    }
    .ie-foot-mid {
      display: flex; gap: 10px; align-items: center;
      font-size: 14px; flex: 1;
    }
    .ie-foot-mid a {
      cursor: pointer; text-decoration: none;
    }
    .ie-foot-right { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    #ie-fab {
      all: initial;
      position: fixed;
      width: 50px; height: 50px;
      background: #007bff; border-radius: 50%;
      color: #fff; display: flex; justify-content: center; align-items: center;
      box-shadow: 0 4px 15px rgba(0,0,0,0.3);
      cursor: grab; z-index: 2147483644;
      font-size: 24px; border: 2px solid #fff;
      bottom: 30px; right: 30px;
      user-select: none; pointer-events: auto;
      transition: transform 0.1s;
      box-sizing: border-box;
      font-family: sans-serif;
      line-height: 1;
    }
    #ie-fab:active { transform: scale(0.95); cursor: grabbing; }
    #ie-preview {
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0,0,0,0.9); z-index: 2147483646;
      display: none; justify-content: center; align-items: center;
      flex-direction: column; pointer-events: auto;
    }
    #ie-p-img {
      max-width: 90%; max-height: 90%; object-fit: contain;
      box-shadow: 0 0 20px rgba(255,255,255,0.2); background: #1a1a1a;
      display: block;
    }
    #ie-p-inf {
      color: #ccc; margin-top: 10px; font-family: monospace;
      background: rgba(0,0,0,0.5); padding: 4px 10px;
      border-radius: 4px; font-size: 13px;
    }
    .ie-hover {
      outline: 3px solid #ff4757 !important;
      box-shadow: inset 0 0 0 1000px rgba(255,71,87,0.05) !important;
    }
    #ie-tip {
      position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
      background: rgba(0,0,0,0.8); color: #fff; padding: 10px 20px;
      border-radius: 20px; z-index: 2147483647;
      display: none; pointer-events: none; font-size: 14px;
      white-space: nowrap;
    }
    .ie-title { font-weight: bold; font-size: 18px; color: #333; white-space: nowrap; }
    a { color: #007bff; }
    select.ie-inp { appearance: auto; }
    .ie-empty {
      text-align: center; padding: 40px; color: #999;
      grid-column: 1 / -1; font-size: 14px; line-height: 1.8;
    }
    .ie-no-img-icon { font-size: 30px; color: #666; }
  `;
  shadowRoot.appendChild(styleEl);

  // --- 工具函数 ---
  const $ = (s, p = shadowRoot) => p.querySelector(s);
  const $$ = (s, p = shadowRoot) => [...p.querySelectorAll(s)];

  const el = (tag, attrs = {}, ...children) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith("on")) e.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "style" && typeof v === "object") Object.assign(e.style, v);
      else if (k === "html") e.innerHTML = v;
      else if (k === "text") e.innerText = v;
      else if (k.startsWith("data-") || k.startsWith("aria-")) e.setAttribute(k, String(v));
      else e[k] = v;
    }
    for (const c of children) {
      if (c) e.appendChild(c instanceof Node ? c : document.createTextNode(c));
    }
    return e;
  };

  // --- 提示 Toast ---
  function showTip(msg, duration = 1500) {
    const t = $("#ie-tip");
    t.innerText = msg;
    t.style.display = "block";
    clearTimeout(showTip._timer);
    showTip._timer = setTimeout(() => (t.style.display = "none"), duration);
  }

  function updateStatus(text, color = "#666") {
    const s = $("#ie-status-text");
    if (s) {
      s.innerText = text;
      s.style.color = color;
    }
  }

  // --- CDN参数清洗 ---
  function cleanImageUrl(url) {
    if (!url || url.startsWith("blob:") || url.startsWith("data:")) return url;
    try {
      const u = new URL(url);
      if (/\?(imageMogr2|imageView2|watermark)\//i.test(url)) return u.origin + u.pathname;
      if (u.searchParams.has("x-oss-process")) {
        u.searchParams.delete("x-oss-process");
        return u.toString();
      }
      const bangIdx = u.pathname.indexOf("!/");
      if (bangIdx !== -1) {
        u.pathname = u.pathname.slice(0, bangIdx);
        return u.toString();
      }
      if (/\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(u.pathname) &&
          /(thumbnail|resize|width|quality|format|imageSlim|imageslim)/i.test(u.search)) {
        return u.origin + u.pathname;
      }
      return url;
    } catch {
      return url;
    }
  }

  // --- 网络请求 ---
  function fetchBlob(url, timeout = 30000) {
    return new Promise((resolve, reject) => {
      try {
        new URL(url);
      } catch {
        return reject(new Error(`无效的URL: ${url}`));
      }

      if (url.startsWith("blob:")) {
        return fetch(url)
          .then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.blob();
          })
          .then((blob) => {
            if (!blob.size) throw new Error("空文件");
            resolve({ blob, type: blob.type.split("/")[1] || "jpg" });
          })
          .catch((e) => reject(new Error(`Blob获取失败: ${e.message}`)));
      }

      GM_xmlhttpRequest({
        method: "GET",
        url,
        responseType: "blob",
        timeout,
        onload: (r) => {
          if (r.status === 200) {
            if (r.response.size > MAX_FILE_SIZE) {
              return reject(new Error(`文件过大: ${(r.response.size / 1024 / 1024).toFixed(1)}MB`));
            }
            const type = r.responseHeaders.match(/content-type:\s*image\/(\w+)/i)?.[1] || "jpg";
            resolve({ blob: r.response, type });
          } else {
            reject(new Error(`HTTP ${r.status}`));
          }
        },
        onerror: (e) => reject(new Error(`网络错误: ${e?.details || "连接失败"}`)),
        ontimeout: () => reject(new Error("请求超时")),
      });
    });
  }

  const getFileName = (_url, ext, idx) => `image${String(idx + 1).padStart(2, "0")}.${ext}`;
  const getExtFromUrl = (url) => url.match(/\.(jpg|jpeg|png|webp|gif|bmp)$/i)?.[1]?.toLowerCase() || "jpg";
  const normalizeExt = (type) => (type === "jpeg" ? "jpg" : type);

  function getProxyUrl(src) {
    const ext = getExtFromUrl(src);
    const randName = `img_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    return `${CFG.workerUrl}/${randName}.${ext}?src=${btoa(src)}&ref=${btoa(location.href)}`;
  }

  // --- 将 blob 转换为可写入剪贴板的 PNG blob ---
  function blobToPngBlob(blob) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      const objUrl = URL.createObjectURL(blob);
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0);
          canvas.toBlob(
            (pngBlob) => {
              URL.revokeObjectURL(objUrl);
              if (pngBlob) resolve(pngBlob);
              else reject(new Error("Canvas转换失败"));
            },
            "image/png"
          );
        } catch (e) {
          URL.revokeObjectURL(objUrl);
          reject(new Error(`Canvas绘制失败: ${e.message}`));
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(objUrl);
        reject(new Error("图片加载失败"));
      };
      img.src = objUrl;
    });
  }

  // --- 复制单张图片到剪贴板 ---
  async function copyImageToClipboard(src) {
    const { blob } = await fetchBlob(src);
    // 剪贴板 API 仅支持 image/png
    let pngBlob;
    if (blob.type === "image/png") {
      pngBlob = blob;
    } else {
      pngBlob = await blobToPngBlob(blob);
    }
    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": pngBlob }),
    ]);
  }

  // --- 批量复制图片到剪贴板（拼接成一张大图）---
  async function copyImagesToClipboard(items) {
    if (!items.length) return;

    // 单张直接复制
    if (items.length === 1) {
      await copyImageToClipboard(items[0].src);
      return;
    }

    // 多张：逐个获取并绘制到 canvas 拼接
    const btn = $("#ie-copy-img");
    const oldText = btn.innerText;

    const loadedImages = [];
    let done = 0;

    for (let i = 0; i < items.length; i += CONCURRENT_LIMIT) {
      const chunk = items.slice(i, i + CONCURRENT_LIMIT);
      const results = await Promise.allSettled(
        chunk.map(async (item) => {
          const { blob } = await fetchBlob(item.src);
          return new Promise((resolve, reject) => {
            const img = new Image();
            const objUrl = URL.createObjectURL(blob);
            img.onload = () => {
              URL.revokeObjectURL(objUrl);
              resolve(img);
            };
            img.onerror = () => {
              URL.revokeObjectURL(objUrl);
              reject(new Error("加载失败"));
            };
            img.src = objUrl;
          });
        })
      );
      for (const r of results) {
        if (r.status === "fulfilled") loadedImages.push(r.value);
        done++;
      }
      btn.innerText = `加载中 ${done}/${items.length}`;
    }

    if (!loadedImages.length) throw new Error("所有图片加载失败");

    // 横向拼接
    const gap = 4;
    const totalWidth = loadedImages.reduce((s, img) => s + img.naturalWidth, 0) + gap * (loadedImages.length - 1);
    const maxHeight = Math.max(...loadedImages.map((img) => img.naturalHeight));

    const canvas = document.createElement("canvas");
    canvas.width = totalWidth;
    canvas.height = maxHeight;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, totalWidth, maxHeight);

    let x = 0;
    for (const img of loadedImages) {
      const y = Math.floor((maxHeight - img.naturalHeight) / 2);
      ctx.drawImage(img, x, y);
      x += img.naturalWidth + gap;
    }

    btn.innerText = "转换中...";

    const pngBlob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("Canvas导出失败"))),
        "image/png"
      );
    });

    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": pngBlob }),
    ]);
  }

  // --- UI 构建 ---
  const app = el(
    "div",
    { id: "ie-overlay" },
    el(
      "div",
      { id: "ie-modal" },
      // Header
      el(
        "div",
        { className: "ie-head" },
        el("div", { className: "ie-title", text: "图片提取 1.2" }),
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
                if (e.target.value !== "-1") {
                  const p = PRESETS[e.target.value];
                  $("#ie-css").value = p.sel;
                  $("#ie-attr").value = p.attr || "";
                  runExtract();
                }
              },
            },
            ...PRESETS.map((p, i) => el("option", { value: i, text: p.name })),
            el("option", { value: "-1", text: "自定义" })
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
            style: { border: "1px solid #ccc", color: "#333", background: "#fff" },
            onclick: runExtract,
          }),
          el("button", {
            className: "ie-btn b-red",
            text: "关闭",
            onclick: () => (app.style.display = "none"),
          })
        )
      ),
      // Body
      el("div", { className: "ie-body" }, el("div", { id: "ie-grid", className: "ie-grid" })),
      // Footer
      el(
        "div",
        { className: "ie-foot" },
        el("div", { className: "ie-status", id: "ie-status-text", html: "就绪" }),
        el(
          "div",
          { className: "ie-foot-mid" },
          el("span", { html: '已选 <b id="ie-num" style="color:#007bff">0</b> 张' }),
          el("a", { text: "全选", onclick: () => setAll(true) }),
          el("a", { text: "清空", style: { color: "#666" }, onclick: () => setAll(false) }),
          el("button", {
            className: "ie-btn b-yel",
            id: "ie-dedup",
            text: "🧹 去重",
            onclick: deduplicate,
          })
        ),
        el(
          "div",
          { className: "ie-foot-right" },
          el(
            "select",
            {
              id: "ie-copy-mode",
              className: "ie-inp",
              style: { padding: "6px 8px", minWidth: "70px", fontSize: "13px" },
            },
            el("option", { value: "original", selected: true, text: "源链接" }),
            el("option", { value: "proxy", text: "中转" })
          ),
          el("button", { className: "ie-btn b-blue", text: "📋 复制链接", onclick: copyLinks }),
          el("button", {
            className: "ie-btn b-purple",
            id: "ie-copy-img",
            text: "🖼️ 复制图片",
            title: "将选中图片复制到剪贴板（多张会拼接）",
            onclick: handleCopyImages,
          }),
          el("button", {
            className: "ie-btn b-green",
            id: "ie-dl-zip",
            text: "📦 下载压缩包",
            onclick: dlZip,
          })
        )
      )
    )
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
    el("div", { id: "ie-p-inf" })
  );

  const tip = el("div", {
    id: "ie-tip",
    html: "移动选择 / <b>W</b> 扩大选中 / <b>S</b> 缩小 / 点击确认 / <b>ESC</b> 退出",
  });

  shadowRoot.append(app, preview, tip);

  // --- 懒加载观察器 ---
  const imgObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const img = entry.target;
          const src = img.dataset.src;
          if (src) {
            img.src = src;
            delete img.dataset.src;
            imgObserver.unobserve(img);
          }
        }
      }
    },
    { root: null, threshold: 0, rootMargin: "0px 0px 200px 0px" }
  );

  // --- FAB 悬浮按钮 ---
  if (CFG.fab && window.self === window.top) {
    const savedPos = JSON.parse(localStorage.getItem("ie_pos") || "null");
    const fab = el("div", { id: "ie-fab", html: "📷", title: "提取图片" });

    if (savedPos) {
      if (savedPos.left) {
        fab.style.left = savedPos.left;
        fab.style.right = "auto";
      }
      if (savedPos.top) {
        fab.style.top = savedPos.top;
        fab.style.bottom = "auto";
      }
    }

    let isDrag = false,
      isPressed = false,
      sx,
      sy;

    fab.addEventListener("mousedown", (e) => {
      isPressed = true;
      isDrag = false;
      sx = e.clientX;
      sy = e.clientY;
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!isPressed || e.buttons !== 1) return;
      if (Math.abs(e.clientX - sx) > 5 || Math.abs(e.clientY - sy) > 5) isDrag = true;
      if (isDrag) {
        fab.style.left = Math.min(window.innerWidth - 54, Math.max(0, e.clientX - 25)) + "px";
        fab.style.top = Math.min(window.innerHeight - 54, Math.max(0, e.clientY - 25)) + "px";
        fab.style.bottom = "auto";
        fab.style.right = "auto";
      }
    });

    document.addEventListener("mouseup", () => {
      if (isPressed && isDrag) {
        localStorage.setItem("ie_pos", JSON.stringify({ left: fab.style.left, top: fab.style.top }));
      }
      isPressed = false;
    });

    fab.addEventListener("click", () => {
      if (!isDrag) openMain();
    });

    shadowRoot.appendChild(fab);
  }

  // 挂载到 documentElement
  const mount = () => {
    if (!document.getElementById("ie-shadow-host")) {
      document.documentElement.appendChild(shadowHost);
    }
  };
  if (document.documentElement) mount();
  else document.addEventListener("DOMContentLoaded", mount);

  // --- 状态 ---
  let images = [],
    isPicking = false,
    curHigh = null;

  // --- 选中数量更新 ---
  function updateSelectedCount() {
    const count = images.filter((i) => i.sel).length;
    const numEl = $("#ie-num");
    if (numEl) numEl.innerText = count;
    return count;
  }

  // --- 主逻辑 ---
  function openMain() {
    app.style.display = "flex";
    const url = location.href;
    let idx = PRESETS.findIndex((p) => p.match instanceof RegExp && p.match.test(url));
    if (idx === -1) idx = 0;
    $("#ie-sel").value = idx;
    $("#ie-css").value = PRESETS[idx].sel;
    $("#ie-attr").value = PRESETS[idx].attr || "";
    runExtract();
  }

  function extractSrcFromElement(elem, targetAttr) {
    if (targetAttr) {
      if (targetAttr === "style") {
        const bg = getComputedStyle(elem).backgroundImage;
        return bg && bg !== "none" ? bg.slice(4, -1).replace(/["']/g, "") : null;
      }
      return targetAttr === "href" ? elem.href : elem.getAttribute(targetAttr);
    }

    // 自动识别
    if (elem.tagName === "A") return elem.href;

    if (elem.tagName === "IMG") {
      const candidates = [
        "data-src-high",
        "data-original",
        "data-lazy-src",
        "data-src",
        "data-url",
        "src",
      ];
      for (const attr of candidates) {
        const val = elem.getAttribute(attr) || elem[attr];
        if (val && !val.includes("placeholder")) return val;
      }
      return elem.src;
    }

    // 其他元素取背景图
    const bg = getComputedStyle(elem).backgroundImage;
    return bg && bg !== "none" ? bg.slice(4, -1).replace(/["']/g, "") : null;
  }

  function normalizeUrl(src) {
    if (!src.startsWith("http") && !src.startsWith("blob:") && !src.startsWith("data:")) {
      try {
        return new URL(src, location.origin).href;
      } catch {
        return null;
      }
    }
    return src;
  }

  function runExtract() {
    const sel = $("#ie-css").value.trim();
    const targetAttr = $("#ie-attr").value.trim();
    if (!sel) return;

    const seen = new Set();
    images = [];

    try {
      // 收集匹配元素
      const elementsSet = new Set();
      $$(sel, document).forEach((e) => elementsSet.add(e));

      const parts = sel.split(/\s+/);
      const lastPart = parts[parts.length - 1]?.toLowerCase() || "";
      if (lastPart !== "img") {
        $$(`${sel} img`, document).forEach((e) => elementsSet.add(e));
      }

      const elements = Array.from(elementsSet);
      const matchedCount = elements.length;

      for (const elem of elements) {
        let src = extractSrcFromElement(elem, targetAttr);
        if (!src) continue;

        src = normalizeUrl(src);
        if (!src) continue;
        if (src.startsWith("data:image/svg+xml")) continue;

        src = cleanImageUrl(src);

        // 过滤极小图片（追踪像素/图标）
        if (elem.tagName === "IMG") {
          const { naturalWidth: nw, naturalHeight: nh } = elem;
          if (nw > 0 && nh > 0 && (nw < 16 || nh < 16)) continue;
        }

        const isValid =
          src.startsWith("http") || src.startsWith("blob:") || src.startsWith("data:image");
        if (isValid && !seen.has(src)) {
          seen.add(src);
          images.push({ src, sel: true, ext: "jpg" });
        }
      }

      updateStatus(`匹配: ${matchedCount} | 有效: ${images.length}`, images.length > 0 ? "#28a745" : "#dc3545");
    } catch (e) {
      console.error(e);
      updateStatus(`选择器错误: ${e.message}`, "#dc3545");
    }

    render();
  }

  function render() {
    const grid = $("#ie-grid");
    grid.innerHTML = "";

    if (!images.length) {
      grid.innerHTML =
        '<div class="ie-empty"><span class="ie-no-img-icon">⚠️</span><br>未找到有效图片链接<br><small>请检查选择器是否正确，或尝试指定属性（如 href）</small></div>';
      updateSelectedCount();
      return;
    }

    const frag = document.createDocumentFragment();

    images.forEach((item, idx) => {
      const resTag = el("div", { className: "ie-res", text: "...", style: { display: "none" } });

      const imgEl = el("img", {
        className: "ie-thumb",
        "data-src": item.src,
        src: PLACEHOLDER_SVG,
        onload: function () {
          if (this.src === PLACEHOLDER_SVG) return;
          const size = `${this.naturalWidth}x${this.naturalHeight}`;
          resTag.innerText = size;
          resTag.style.display = "block";
          item.size = size;
        },
        onerror: function () {
          if (this.src === PLACEHOLDER_SVG) return;
          this.style.display = "none";
          this.parentElement.appendChild(el("div", { className: "ie-no-img-icon", text: "📄" }));
        },
      });

      const card = el(
        "div",
        {
          className: `ie-card ${item.sel ? "sel" : ""}`,
          onclick: (e) => {
            if (!e.target.closest(".ie-act") && !e.target.closest(".ie-ck")) {
              item.sel = !item.sel;
              card.classList.toggle("sel", item.sel);
              updateSelectedCount();
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
              card.classList.toggle("sel", item.sel);
              updateSelectedCount();
              e.stopPropagation();
            },
          })
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
            html: "📋",
            title: "复制图片到剪贴板",
            style: { color: "#6f42c1" },
            onclick: async function (e) {
              e.stopPropagation();
              await copyOneImage(item, this);
            },
          }),
          el("button", {
            className: "ie-act",
            html: "🔗",
            title: "复制链接",
            style: { color: "#dc3545" },
            onclick: (e) => {
              e.stopPropagation();
              copyOneLink(item);
            },
          })
        )
      );

      frag.appendChild(card);
    });

    grid.appendChild(frag);
    $$(".ie-thumb", grid).forEach((img) => imgObserver.observe(img));
    updateSelectedCount();
  }

  // --- 功能模块 ---
  function setAll(val) {
    images.forEach((i) => (i.sel = val));
    render();
  }

  function deduplicate() {
    const keyMap = new Map();
    let cnt = 0;
    for (const i of images) {
      if (!i.sel) continue;
      if (i.size) {
        const [w, h] = i.size.split("x").map(Number);
        if (w < 50 || h < 50) {
          i.sel = false;
          cnt++;
          continue;
        }
      }
      const base = i.src.replace(/^http:/, "https:").split("?")[0].toLowerCase();
      const key = `${base}|${i.size || "0x0"}`;
      if (keyMap.has(key)) {
        i.sel = false;
        cnt++;
      } else {
        keyMap.set(key, true);
      }
    }
    render();
    const btn = $("#ie-dedup");
    btn.innerText = `过滤 ${cnt}`;
    setTimeout(() => (btn.innerText = "🧹 去重"), 1500);
  }

  function showPreview(src) {
    preview.style.display = "flex";
    const img = $("#ie-p-img");
    const infoEl = $("#ie-p-inf");
    infoEl.style.color = "#ccc";
    try {
      new URL(src);
      img.src = "";
      img.src = src;
      infoEl.innerText = "Loading...";
      img.onload = function () {
        infoEl.innerText = `${this.naturalWidth} x ${this.naturalHeight} px`;
      };
      img.onerror = function () {
        infoEl.innerText = "预览不可用";
        infoEl.style.color = "#dc3545";
      };
    } catch (e) {
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
      const ext = normalizeExt(type);
      saveAs(blob, getFileName(item.src, ext, idx));
      btn.innerHTML = "✅";
      updateStatus(`下载成功: ${getFileName(item.src, ext, idx)}`, "#28a745");
    } catch (e) {
      btn.innerHTML = "❌";
      updateStatus(`下载失败: ${e.message}`, "#dc3545");
    }
    setTimeout(() => {
      btn.innerHTML = old;
      btn.disabled = false;
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
      let done = 0,
        fail = 0;
      const errors = [];
      const usedNames = new Set();

      const resolveUniqueName = (fileName) => {
        if (!usedNames.has(fileName)) {
          usedNames.add(fileName);
          return fileName;
        }
        const lastDot = fileName.lastIndexOf(".");
        const base = lastDot !== -1 ? fileName.slice(0, lastDot) : fileName;
        const ext = lastDot !== -1 ? fileName.slice(lastDot) : ".jpg";
        let i = 1,
          candidate;
        do {
          candidate = `${base}_${i}${ext}`;
          i++;
        } while (usedNames.has(candidate));
        usedNames.add(candidate);
        return candidate;
      };

      for (let i = 0; i < sels.length; i += CONCURRENT_LIMIT) {
        const chunk = sels.slice(i, i + CONCURRENT_LIMIT);
        await Promise.all(
          chunk.map((item, subIdx) => {
            const globalIdx = i + subIdx;
            return fetchBlob(item.src)
              .then(({ blob, type }) => {
                const ext = normalizeExt(type);
                folder.file(resolveUniqueName(getFileName(item.src, ext, globalIdx)), blob);
                done++;
              })
              .catch((e) => {
                fail++;
                errors.push({ url: item.src, error: e.message });
              })
              .finally(() => {
                btn.innerText = `下载中 ${done + fail}/${sels.length}`;
              });
          })
        );
      }

      if (done > 0) {
        btn.innerText = "打包中...";
        const zipBlob = await zip.generateAsync({ type: "blob" });
        saveAs(zipBlob, `Images_${document.title}_${Date.now()}.zip`);
        if (fail > 0) {
          updateStatus(`完成: ${done} 成功, ${fail} 失败`, "#ffc107");
          console.log("失败列表:", errors);
        } else {
          updateStatus(`ZIP下载成功: ${done} 个文件`, "#28a745");
        }
      } else {
        throw new Error("所有图片下载均失败");
      }
    } catch (e) {
      updateStatus(`ZIP失败: ${e.message}`, "#dc3545");
      alert(`ZIP下载失败: ${e.message}`);
    } finally {
      btn.innerText = old;
      btn.disabled = false;
    }
  }

  // --- 复制单张图片到剪贴板 ---
  async function copyOneImage(item, btn) {
    if (btn.disabled) return;
    const old = btn.innerHTML;
    btn.innerHTML = "⏳";
    btn.disabled = true;
    try {
      await copyImageToClipboard(item.src);
      btn.innerHTML = "✅";
      showTip("图片已复制到剪贴板");
      updateStatus("图片已复制到剪贴板", "#28a745");
    } catch (e) {
      btn.innerHTML = "❌";
      updateStatus(`复制图片失败: ${e.message}`, "#dc3545");
      showTip(`复制失败: ${e.message}`, 2000);
    }
    setTimeout(() => {
      btn.innerHTML = old;
      btn.disabled = false;
    }, 2000);
  }

  // --- 批量复制图片 ---
  async function handleCopyImages() {
    const sels = images.filter((i) => i.sel);
    if (!sels.length) {
      alert("请先选择图片");
      return;
    }

    const btn = $("#ie-copy-img");
    const old = btn.innerText;
    btn.innerText = "准备中...";
    btn.disabled = true;

    try {
      if (!navigator.clipboard?.write) {
        throw new Error("当前浏览器不支持剪贴板写入图片，请使用Chrome/Edge最新版");
      }

      await copyImagesToClipboard(sels);

      const msg =
        sels.length === 1
          ? "1 张图片已复制到剪贴板"
          : `${sels.length} 张图片已拼接复制到剪贴板`;
      showTip(msg, 2000);
      updateStatus(msg, "#28a745");
    } catch (e) {
      updateStatus(`复制图片失败: ${e.message}`, "#dc3545");
      showTip(`复制失败: ${e.message}`, 2500);
    } finally {
      btn.innerText = old;
      btn.disabled = false;
    }
  }

  // --- 复制单条链接 ---
  function copyOneLink(item) {
    const mode = $("#ie-copy-mode").value || "original";
    const link = mode === "proxy" ? getProxyUrl(item.src) : item.src;
    navigator.clipboard
      .writeText(link)
      .then(() => showTip(`${mode === "proxy" ? "中转" : "源"}链接已复制`))
      .catch(() => {
        try {
          const ta = document.createElement("textarea");
          ta.value = link;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
          showTip("链接已复制（降级）");
        } catch {
          alert(`请手动复制:\n${link}`);
        }
      });
  }

  // --- 批量复制链接 ---
  function copyLinks() {
    const mode = $("#ie-copy-mode").value || "original";
    const links = images
      .filter((i) => i.sel)
      .map((i) => (mode === "proxy" ? getProxyUrl(i.src) : i.src));
    if (!links.length) {
      alert("请先选择图片");
      return;
    }
    navigator.clipboard
      .writeText(links.join("\n"))
      .then(() => {
        showTip(`已复制 ${links.length} 条链接`);
        updateStatus(`已复制 ${links.length} 条链接`, "#28a745");
      })
      .catch(() => alert("复制失败，请检查浏览器权限"));
  }

  // --- 元素选取器 ---
  function startPick() {
    isPicking = true;
    app.style.display = "none";
    tip.innerHTML =
      "移动选择 / <b>W</b> 扩大选中 / <b>S</b> 缩小 / 点击确认 / <b>ESC</b> 退出";
    tip.style.display = "block";

    const over = (e) => {
      if (shadowHost.contains(e.target)) return;
      e.stopPropagation();
      if (curHigh) curHigh.classList.remove("ie-hover");
      curHigh = e.target;
      curHigh.classList.add("ie-hover");
    };

    const down = (e) => {
      if (!isPicking || shadowHost.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      const target = curHigh || e.target;
      const cls = `ie-pick-${Date.now()}`;
      target.classList.add(cls);
      $("#ie-sel").value = "-1";
      if (target.tagName === "A") {
        $("#ie-css").value = `.${cls}`;
        $("#ie-attr").value = "href";
      } else if (target.tagName === "IMG") {
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
        curHigh = curHigh.parentElement;
        curHigh.classList.add("ie-hover");
      }
      if ((e.key === "s" || e.key === "ArrowDown") && curHigh?.firstElementChild) {
        curHigh.classList.remove("ie-hover");
        curHigh = curHigh.firstElementChild;
        curHigh.classList.add("ie-hover");
      }
    };

    document.addEventListener("mouseover", over);
    document.addEventListener("click", down, true);
    document.addEventListener("keydown", key);

    window._ie_exit = () => {
      isPicking = false;
      app.style.display = "flex";
      tip.style.display = "none";
      if (curHigh) {
        curHigh.classList.remove("ie-hover");
        curHigh = null;
      }
      document.removeEventListener("mouseover", over);
      document.removeEventListener("click", down, true);
      document.removeEventListener("keydown", key);
    };
  }

  function exitPick() {
    window._ie_exit?.();
  }

  // --- 快捷键与菜单 ---
  GM_registerMenuCommand("📥 提取图片", openMain);

  document.addEventListener("keydown", (e) => {
    if (e.altKey && e.key.toLowerCase() === "i") {
      app.style.display === "flex" ? (app.style.display = "none") : openMain();
    }
    if (e.key === "Escape") preview.style.display = "none";
  });
})();