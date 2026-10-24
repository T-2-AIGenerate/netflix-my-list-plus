(() => {
  "use strict";
  // This script runs only on Netflix. It observes Netflix GraphQL responses
  // and forwards only candidate title records to the isolated extension content script.
  if (window.__nmlpNetworkObserverInstalled) return;
  window.__nmlpNetworkObserverInstalled = true;
  const isMyListPage = () => /\/browse\/my-list(?:\/|$)/i.test(location.pathname);
  const allowedHost = () => location.hostname === "www.netflix.com";
  const emit = (operationName, payload) => {
    if (!isMyListPage() || !allowedHost()) return;
    window.postMessage({
      source: "NMLP_NET_OBSERVER",
      operationName: String(operationName || ""),
      payload
    }, location.origin);
  };
  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function(input, init) {
      let url = "";
      try { url = typeof input === "string" ? input : input?.url || ""; } catch {}
      const body = init?.body;
      const shouldInspect = /\/graphql(?:\?|$)/i.test(url) && typeof body === "string" && isMyListPage();
      let operationName = "";
      if (shouldInspect) {
        try { operationName = JSON.parse(body)?.operationName || ""; } catch {}
      }
      return originalFetch.apply(this, arguments).then(response => {
        if (shouldInspect && response.ok) {
          // Restrict capture to GraphQL operations explicitly associated with My List.
          if (/my.?list/i.test(operationName)) {
            try {
              response.clone().json().then(payload => emit(operationName, payload)).catch(() => {});
            } catch {}
          }
        }
        return response;
      });
    };
  }
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype && !XHR.prototype.__nmlpWrapped) {
    const originalOpen = XHR.prototype.open;
    const originalSend = XHR.prototype.send;
    XHR.prototype.open = function(method, url) {
      this.__nmlpUrl = String(url || "");
      return originalOpen.apply(this, arguments);
    };
    XHR.prototype.send = function(body) {
      const xhr = this;
      let operationName = "";
      if (isMyListPage() && /\/graphql(?:\?|$)/i.test(xhr.__nmlpUrl || "") && typeof body === "string") {
        try { operationName = JSON.parse(body)?.operationName || ""; } catch {}
      }
      if (/my.?list/i.test(operationName)) {
        xhr.addEventListener("load", function() {
          if (!xhr.responseURL || !/\/graphql(?:\?|$)/i.test(xhr.responseURL) || xhr.status < 200 || xhr.status >= 300) return;
          try {
            const payload = typeof xhr.response === "object" && xhr.response ? xhr.response : JSON.parse(xhr.responseText);
            emit(operationName, payload);
          } catch {}
        }, { once: true });
      }
      return originalSend.apply(this, arguments);
    };
    XHR.prototype.__nmlpWrapped = true;
  }
})();
