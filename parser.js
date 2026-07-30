(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.FlowParser = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function naturalNumberParts(number) {
    return number.split(".").map(Number);
  }

  function compareNumbers(a, b) {
    const aa = naturalNumberParts(a), bb = naturalNumberParts(b);
    for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
      if ((aa[i] ?? -1) !== (bb[i] ?? -1)) return (aa[i] ?? -1) - (bb[i] ?? -1);
    }
    return 0;
  }

  function parseSource(text) {
    const nodes = [], errors = [], numbers = new Set();
    const rawLines = text.replace(/\r/g, "").split("\n");
    rawLines.forEach((raw, index) => {
      if (!raw.trim()) return;
      const lineNo = index + 1;
      const leading = raw.match(/^[\t ]*/)[0];
      if (leading.includes(" ")) errors.push(`第 ${lineNo} 行：階層只能使用 Tab，不可使用空白。`);
      const tabs = (leading.match(/\t/g) || []).length;
      const body = raw.slice(leading.length);
      const match = body.match(/^(\d+(?:\.\d+)*)[.、)]?\s*(.+)$/);
      if (!match) {
        errors.push(`第 ${lineNo} 行：格式錯誤，應為「編號.文字」。`);
        return;
      }
      const number = match[1], textValue = match[2].trim(), parts = naturalNumberParts(number);
      if (numbers.has(number)) errors.push(`第 ${lineNo} 行：編號 ${number} 重複。`);
      numbers.add(number);
      const expectedTabs = parts.length - 1;
      if (tabs !== expectedTabs) errors.push(`第 ${lineNo} 行：${number} 應使用 ${expectedTabs} 個 Tab，實際為 ${tabs} 個。`);
      if (parts.length > 1) {
        const parentNumber = parts.slice(0, -1).join(".");
        if (!numbers.has(parentNumber)) errors.push(`第 ${lineNo} 行：找不到父節點 ${parentNumber}。`);
      }
      nodes.push({ number, text: textValue, parts, tabs });
    });
    if (!nodes.length) errors.push("沒有可建立的節點。");
    return { nodes, errors };
  }

  return { naturalNumberParts, compareNumbers, parseSource };
});
