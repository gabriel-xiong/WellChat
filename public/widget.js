(function () {
  "use strict";

  var FRAME_ID = "the-well-chat-widget-frame";
  var MESSAGE_SOURCE = "the-well-widget";
  var DESKTOP_WIDTH = 460;
  var DESKTOP_HEIGHT = 720;
  var DESKTOP_COLLAPSED_WIDTH = 240;
  var DESKTOP_COLLAPSED_HEIGHT = 112;
  var MOBILE_COLLAPSED_SIZE = 88;

  if (document.getElementById(FRAME_ID)) return;

  var loaderScript = document.currentScript;
  if (!loaderScript || !loaderScript.src) return;

  var loaderUrl = new URL(loaderScript.src, window.location.href);
  var widgetOrigin = loaderUrl.origin;
  var site = loaderScript.getAttribute("data-site") || "the-well";
  var iframe = document.createElement("iframe");
  var isOpen = false;

  iframe.id = FRAME_ID;
  iframe.src = widgetOrigin + "/widget?site=" + encodeURIComponent(site) +
    "&parentOrigin=" + encodeURIComponent(window.location.origin);
  iframe.title = "The Well website assistant";
  iframe.setAttribute("aria-label", "The Well website assistant");
  iframe.setAttribute("loading", "eager");
  iframe.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
  iframe.setAttribute(
    "sandbox",
    "allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
  );
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = (window.innerWidth <= 640 ? MOBILE_COLLAPSED_SIZE : DESKTOP_COLLAPSED_WIDTH) + "px";
  iframe.style.height = (window.innerWidth <= 640 ? MOBILE_COLLAPSED_SIZE : DESKTOP_COLLAPSED_HEIGHT) + "px";
  iframe.style.border = "0";
  iframe.style.background = "transparent";
  iframe.style.zIndex = "2147483000";
  iframe.style.colorScheme = "normal";

  function resizeFrame(open) {
    isOpen = open;

    if (!open) {
      var isMobile = window.innerWidth <= 640;
      iframe.style.width = (isMobile ? MOBILE_COLLAPSED_SIZE : DESKTOP_COLLAPSED_WIDTH) + "px";
      iframe.style.height = (isMobile ? MOBILE_COLLAPSED_SIZE : DESKTOP_COLLAPSED_HEIGHT) + "px";
      return;
    }

    var isMobile = window.innerWidth <= 640;
    iframe.style.width = isMobile ? "100vw" : Math.min(window.innerWidth, DESKTOP_WIDTH) + "px";
    iframe.style.height = isMobile ? "100dvh" : Math.min(window.innerHeight, DESKTOP_HEIGHT) + "px";
  }

  function handleMessage(event) {
    if (event.origin !== widgetOrigin || event.source !== iframe.contentWindow) return;
    if (!event.data || event.data.source !== MESSAGE_SOURCE || event.data.type !== "resize") return;

    resizeFrame(Boolean(event.data.open));
  }

  function mountWidget() {
    document.body.appendChild(iframe);
    window.addEventListener("message", handleMessage);
    window.addEventListener("resize", function () {
      resizeFrame(isOpen);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountWidget, { once: true });
  } else {
    mountWidget();
  }
})();
