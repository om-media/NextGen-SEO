import assert from "node:assert/strict";
import { classifyIntent } from "./gscGridUtils";

const site = "avanterrapark.com/";

assert.equal(classifyIntent("avanterra park lopar", site), "Navigational");
assert.equal(classifyIntent("avanterra park", "sc-domain:avanterrapark.com"), "Navigational");
assert.equal(classifyIntent("avanterra", "https://www.avanterrapark.com/"), "Navigational");
assert.equal(classifyIntent("avanterra park tickets", site), "Commercial");
assert.equal(classifyIntent("adventure park lopar", site), "Commercial");
assert.equal(classifyIntent("how to get to avanterra park", site), "Informational");
assert.equal(classifyIntent("what is an adventure park", site), "Informational");
assert.equal(classifyIntent("xylophone quantum widget", site), "Unclassified");

console.log("gscGridUtils intent checks passed");
