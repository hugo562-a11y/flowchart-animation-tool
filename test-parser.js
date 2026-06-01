"use strict";

const assert = require("node:assert");
const { parseSource, compareNumbers } = require("./parser.js");

const valid = `1.讀取 SpaceMouse 六軸
2.確認游標所在區域
3.畫布區
\t3.1優先允許 Z：縮放畫布
\t\t3.1.1放大
\t3.2平移
4.時間軸區`;
const parsed = parseSource(valid);
assert.deepStrictEqual(parsed.errors, []);
assert.strictEqual(parsed.nodes.length, 7);
assert.deepStrictEqual(["3.2", "3.1.1", "3.1"].sort(compareNumbers), ["3.1", "3.1.1", "3.2"]);

const spaces = parseSource("1.根節點\n  1.1錯誤空白");
assert.ok(spaces.errors.some((error) => error.includes("只能使用 Tab")));

const missingParent = parseSource("1.根節點\n\t2.1缺少父節點");
assert.ok(missingParent.errors.some((error) => error.includes("找不到父節點 2")));

const duplicate = parseSource("1.根節點\n1.重複");
assert.ok(duplicate.errors.some((error) => error.includes("編號 1 重複")));

console.log("parser tests passed");
