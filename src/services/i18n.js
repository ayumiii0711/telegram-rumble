const path = require("path");

const supported = ["ja", "en", "zh"];

function loadLocaleJson(filePath) {
  delete require.cache[require.resolve(filePath)];
  return require(filePath);
}

const bundles = Object.fromEntries(
  supported.map((key) => [
    key,
    loadLocaleJson(path.join(__dirname, "../locales", `${key}.json`)),
  ])
);

function normalizeLang(input) {
  if (!input) return "en";
  const lower = input.toLowerCase();
  if (lower.startsWith("ja")) return "ja";
  if (lower.startsWith("zh")) return "zh";
  return "en";
}

function detectLang(userLangCode, groupSetting) {
  if (groupSetting && supported.includes(groupSetting)) return groupSetting;
  return normalizeLang(userLangCode);
}

function t(lang, key, vars = {}) {
  const msg = (bundles[lang] && bundles[lang][key]) || bundles.en[key] || key;
  return Object.entries(vars).reduce(
    (acc, [k, v]) => acc.replaceAll(`{${k}}`, String(v)),
    msg
  );
}

function getEffects(lang) {
  return ["effect_1", "effect_2", "effect_3", "effect_4"].map((k) => bundles[lang][k] || bundles.en[k]);
}

module.exports = { detectLang, t, getEffects, supported };
