/**
 * GeminiFleet.js — Full-fleet Dynamic Model Discovery, Tiered Failover & Daily Quota State Tracking
 * Part of SparkCore (Google Apps Script Shared Library)
 */

var GeminiFleet = (function() {
  const DEFAULT_MODEL_LADDER = [
    "gemini-2.5-flash",              // Tier 1: Primary workhorse (optimal extraction & reasoning)
    "gemini-2.5-flash-lite",         // Tier 2: Separate high-speed rate-limit quota bucket
    "gemini-flash-latest",          // Tier 3: Rolling latest production flash release
    "gemini-flash-lite-latest",     // Tier 4: Rolling latest lite flash release
    "gemini-3.5-flash",             // Tier 5: Next-gen 3.5 flash cluster
    "gemini-3.5-flash-lite",        // Tier 6: Next-gen 3.5 lite cluster
    "gemini-3.1-flash-lite",        // Tier 7: Gen 3.1 lite cluster
    "gemini-3.1-flash-lite-preview",// Tier 8: Gen 3.1 preview cluster
    "gemini-3-flash-preview",       // Tier 9: Gen 3 preview cluster
    "gemini-3.6-flash",             // Tier 10: Gen 3.6 flash cluster
    "gemini-3.7-flash",             // Tier 11: Gen 3.7 flash cluster
    "gemini-3.8-flash",             // Tier 12: Gen 3.8 flash cluster
    "gemini-omni-flash-preview",    // Tier 13: Omni multimodal preview cluster
    "gemini-omni-1.1-flash",        // Tier 14: Omni 1.1 flash cluster
    "gemini-2.5-pro",               // Tier 15: Deep reasoning pro cluster
    "gemini-pro-latest",            // Tier 16: Rolling latest production pro release
    "gemini-3.1-pro-preview",       // Tier 17: Gen 3.1 pro preview cluster
    "gemini-4-argon"                // Tier 18: Advanced flagship frontier cluster
  ];

  function getModelPriority(modelName) {
    const clean = String(modelName || "").replace(/^models\//, "");
    const idx = DEFAULT_MODEL_LADDER.indexOf(clean);
    return idx !== -1 ? (idx + 1) * 10 : 999;
  }

  const PRIORITY_MAP = {};
  DEFAULT_MODEL_LADDER.forEach(function(m, i) {
    PRIORITY_MAP[m] = (i + 1) * 10;
  });

  const EXCLUDED_KEYWORDS = [
    "tts", "image", "lyria", "transcribe", "robotics",
    "computer-use", "deep-research", "banana", "embed", "aqa"
  ];

  /**
   * Distinguishes daily quota exhaustion (RPD) from per-minute transient limits (RPM).
   */
  function isDailyQuotaError(statusCode, responseText) {
    if (statusCode !== 429) return false;
    if (!responseText) return false;
    const text = String(responseText).toLowerCase();
    return (
      text.includes("per day") ||
      text.includes("perday") ||
      text.includes("requests per day") ||
      text.includes("daily") ||
      text.includes("free tier per day") ||
      text.includes("limit: 0") ||
      text.includes("quota exceeded for quota metric 'generatecontent requests' and limit 'generatecontent requests per day")
    );
  }

  /**
   * Calculates remaining seconds until the next UTC midnight.
   */
  function getSecondsUntilUtcMidnight() {
    const now = new Date();
    const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
    return Math.max(60, Math.floor((tomorrow.getTime() - now.getTime()) / 1000));
  }

  /**
   * Marks a model as daily-exhausted across CacheService (memory) and ScriptProperties (durable).
   */
  function markModelDailyExhausted(model) {
    const secondsLeft = getSecondsUntilUtcMidnight();
    const resetTimestamp = Date.now() + secondsLeft * 1000;

    try {
      if (typeof CacheService !== "undefined" && CacheService.getScriptCache) {
        const cache = CacheService.getScriptCache();
        if (cache) {
          cache.put("DAILY_EXHAUSTED_" + model, "true", Math.min(21600, secondsLeft));
        }
      }
    } catch (e) {
      if (typeof Logger !== "undefined") Logger.log("[WARN] CacheService update failed: " + e.toString());
    }

    try {
      if (typeof PropertiesService !== "undefined" && PropertiesService.getScriptProperties) {
        const props = PropertiesService.getScriptProperties();
        if (props) {
          props.setProperty("DAILY_EXHAUSTED_" + model, String(resetTimestamp));
        }
      }
    } catch (e) {
      if (typeof Logger !== "undefined") Logger.log("[WARN] ScriptProperties update failed: " + e.toString());
    }

    const hoursLeft = (secondsLeft / 3600).toFixed(1);
    if (typeof Logger !== "undefined") {
      Logger.log('[DAILY_LIMIT_EXCEEDED] Model "' + model + '" hit daily quota limit. Banned until UTC midnight (~' + hoursLeft + 'h remaining).');
    }
  }

  /**
   * Checks if a model is currently banned due to daily quota exhaustion.
   */
  function isModelDailyExhausted(model) {
    try {
      if (typeof CacheService !== "undefined" && CacheService.getScriptCache) {
        const cache = CacheService.getScriptCache();
        if (cache && cache.get("DAILY_EXHAUSTED_" + model) === "true") {
          return true;
        }
      }

      if (typeof PropertiesService !== "undefined" && PropertiesService.getScriptProperties) {
        const props = PropertiesService.getScriptProperties();
        if (props) {
          const resetTimeStr = props.getProperty("DAILY_EXHAUSTED_" + model);
          if (resetTimeStr) {
            const resetTime = parseInt(resetTimeStr, 10);
            if (Date.now() < resetTime) {
              return true;
            } else {
              props.deleteProperty("DAILY_EXHAUSTED_" + model);
              return false;
            }
          }
        }
      }
    } catch (e) {
      if (typeof Logger !== "undefined") Logger.log('[WARN] Error checking model exhaustion status for "' + model + '": ' + e.toString());
    }
    return false;
  }

  /**
   * Clears all model bans from CacheService and ScriptProperties.
   */
  function clearModelBans() {
    try {
      let cache = null;
      if (typeof CacheService !== "undefined" && CacheService.getScriptCache) {
        cache = CacheService.getScriptCache();
      }

      DEFAULT_MODEL_LADDER.forEach(function(m) {
        if (cache) {
          try { cache.remove("DAILY_EXHAUSTED_" + m); } catch (_) {}
        }
      });

      if (typeof PropertiesService !== "undefined" && PropertiesService.getScriptProperties) {
        const props = PropertiesService.getScriptProperties();
        if (props) {
          const allProps = props.getProperties();
          Object.keys(allProps).forEach(function(k) {
            if (k.indexOf("DAILY_EXHAUSTED_") === 0) {
              if (cache) {
                try { cache.remove(k); } catch (_) {}
              }
              try { props.deleteProperty(k); } catch (_) {}
            }
          });
        }
      }
    } catch (e) {
      if (typeof Logger !== "undefined") Logger.log("[WARN] Error clearing model bans: " + e.toString());
    }
  }

  /**
   * Dynamically queries the Gemini API to discover all available models supporting generateContent,
   * filtering out specialized/image endpoints and prioritizing Flash tiers.
   */
  function discoverAvailableModels(apiKey, options) {
    options = options || {};
    const cacheKey = "DISCOVERED_GEMINI_MODELS";

    if (!options.bypassCache) {
      try {
        if (typeof CacheService !== "undefined" && CacheService.getScriptCache) {
          const cache = CacheService.getScriptCache();
          if (cache) {
            const cached = cache.get(cacheKey);
            if (cached) {
              return JSON.parse(cached);
            }
          }
        }
      } catch (e) {
        if (typeof Logger !== "undefined") Logger.log("[WARN] CacheService lookup failed: " + e.toString());
      }
    }

    if (!apiKey) {
      return DEFAULT_MODEL_LADDER;
    }

    const url = "https://generativelanguage.googleapis.com/v1beta/models";
    try {
      if (typeof UrlFetchApp !== "undefined") {
        const response = UrlFetchApp.fetch(url, {
          method: "get",
          headers: {
            "x-goog-api-key": apiKey
          },
          muteHttpExceptions: true
        });
        if (response.getResponseCode() === 200) {
          const json = JSON.parse(response.getContentText());
          const rawModels = json.models || [];

          const discovered = rawModels
            .filter(function(m) {
              return Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes("generateContent");
            })
            .map(function(m) {
              return m.name.replace(/^models\//, "");
            })
            .filter(function(name) {
              const lower = name.toLowerCase();
              return !EXCLUDED_KEYWORDS.some(function(keyword) { return lower.includes(keyword); });
            })
            .sort(function(a, b) {
              return getModelPriority(a) - getModelPriority(b);
            });

          if (discovered.length > 0) {
            try {
              if (typeof CacheService !== "undefined" && CacheService.getScriptCache) {
                const cache = CacheService.getScriptCache();
                if (cache) {
                  cache.put(cacheKey, JSON.stringify(discovered), 21600); // 6 hours
                }
              }
            } catch (_) {}
            if (typeof Logger !== "undefined") {
              Logger.log("[MODEL_DISCOVERY] Discovered " + discovered.length + " Gemini models: [" + discovered.join(", ") + "]");
            }
            return discovered;
          }
        }
      }
    } catch (e) {
      if (typeof Logger !== "undefined") {
        Logger.log("[WARN] Dynamic model discovery failed (" + e.toString() + "). Falling back to default ladder.");
      }
    }

    return DEFAULT_MODEL_LADDER;
  }

  /**
   * Assembles the active dynamic model ladder filtering out daily-banned models.
   */
  function getDynamicModelLadder(apiKey, configLadder) {
    let candidates = [];
    if (typeof configLadder === "string" && configLadder.trim()) {
      candidates = [configLadder.trim().replace(/^models\//, "")];
    } else if (Array.isArray(configLadder) && configLadder.length > 0 && configLadder !== DEFAULT_MODEL_LADDER) {
      candidates = configLadder.map(function(m) {
        return String(m || "").trim().replace(/^models\//, "");
      }).filter(Boolean);
    } else {
      candidates = discoverAvailableModels(apiKey);
    }

    const activeLadder = candidates.filter(function(m) {
      return !isModelDailyExhausted(m);
    });

    if (activeLadder.length > 0) {
      return activeLadder;
    }

    if (typeof Logger !== "undefined") {
      Logger.log("[WARN] All models in candidate list have hit daily quota limits! Attempting primary model as last resort.");
    }
    return candidates.slice(0, 1);
  }

  /**
   * Calls the Gemini API with dynamic model ladder rotation, exponential backoff, and daily limit tracking.
   */
  function callGeminiAPI(payload, apiKey, modelOrLadder, options) {
    options = options || {};
    const ladder = getDynamicModelLadder(apiKey, modelOrLadder);
    if (typeof Logger !== "undefined") {
      Logger.log("[MODEL_LADDER_ACTIVE] Running with active ladder (" + ladder.length + " models): [" + ladder.join(" -> ") + "]");
    }

    for (let i = 0; i < ladder.length; i++) {
      if (typeof options.isTimeExpiring === "function" && options.isTimeExpiring()) {
        if (typeof Logger !== "undefined") {
          Logger.log("[HALT] Execution time budget expiring. Aborting model ladder iteration.");
        }
        return null;
      }

      const rawModel = ladder[i];
      const model = String(rawModel || "").replace(/^models\//, "");
      const url = "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent";
      const fetchOptions = {
        method: "post",
        contentType: "application/json",
        headers: {
          "x-goog-api-key": apiKey
        },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      };

      try {
        let response = UrlFetchApp.fetch(url, fetchOptions);
        let code = response.getResponseCode();
        let responseText = response.getContentText();

        // 1. Check for Daily Limit Quota Exhaustion (RPD)
        if (isDailyQuotaError(code, responseText)) {
          markModelDailyExhausted(model);
          const nextModel = ladder[i + 1];
          if (nextModel) {
            if (typeof Logger !== "undefined") {
              Logger.log('[MODEL_LADDER_ROTATE] Daily quota exceeded for "' + model + '". Falling back to "' + nextModel + '"...');
            }
            continue;
          } else {
            if (typeof Logger !== "undefined") {
              Logger.log("[MODEL_LADDER_EXHAUSTED] All models in dynamic ladder have exhausted their daily quotas.");
            }
            return null;
          }
        }

        // 2. Check for Transient Rate Limits (RPM / 503)
        if (code === 429 || code === 503) {
          const delay = options.retryDelayMs || 1500;
          if (typeof Logger !== "undefined") {
            Logger.log('[QUOTA_TRANSIENT] Model "' + model + '" throttled (HTTP ' + code + '). Pausing ' + delay + 'ms...');
          }
          if (typeof Utilities !== "undefined" && Utilities.sleep) {
            Utilities.sleep(delay);
          }
          response = UrlFetchApp.fetch(url, fetchOptions);
          code = response.getResponseCode();
          responseText = response.getContentText();

          if (isDailyQuotaError(code, responseText)) {
            markModelDailyExhausted(model);
          }
        }

        // 2. Fast-exit on deterministic client errors (bad request, invalid API key, permission denied)
        if (code === 400 || code === 401 || code === 403) {
          if (typeof Logger !== "undefined") {
            Logger.log('[FATAL] Gemini API client error (HTTP ' + code + '): ' + responseText);
          }
          return null;
        }

        // 3. Persistent error on current model: Rotate
        if (code === 429 || code === 503) {
          const nextModel = ladder[i + 1];
          if (nextModel) {
            if (typeof Logger !== "undefined") {
              Logger.log('[MODEL_LADDER_ROTATE] Model "' + model + '" quota exhausted (HTTP ' + code + '). Rotating down to "' + nextModel + '"...');
            }
            continue;
          } else {
            if (typeof Logger !== "undefined") {
              Logger.log("[MODEL_LADDER_EXHAUSTED] All models in ladder exhausted.");
            }
            return null;
          }
        }

        if (code !== 200) {
          if (typeof Logger !== "undefined") {
            Logger.log('[ERROR] Model "' + model + '" returned HTTP ' + code + ': ' + responseText);
          }
          continue;
        }

        const json = JSON.parse(responseText);

        // Fast-exit on safety, recitation, or blocklist blocks
        const candidate = json.candidates && json.candidates[0];
        const finishReason = candidate && candidate.finishReason;
        const promptFeedback = json.promptFeedback;
        const blockReason = (promptFeedback && promptFeedback.blockReason) ||
          (finishReason === "SAFETY" || finishReason === "RECITATION" || finishReason === "BLOCKLIST" ? finishReason : null);

        if (blockReason) {
          if (typeof Logger !== "undefined") {
            Logger.log('[BLOCKED] Content generation blocked by safety policy (' + blockReason + '). Aborting rotation.');
          }
          return { error: "BLOCKED_BY_SAFETY", reason: blockReason, _modelUsed: model };
        }

        const candidateText = candidate && candidate.content && candidate.content.parts && candidate.content.parts[0] ? candidate.content.parts[0].text : null;
        if (!candidateText) {
          if (typeof Logger !== "undefined") {
            Logger.log('[WARN] Model "' + model + '" returned no candidate text.');
          }
          continue;
        }

        let parsedData = null;
        try {
          // If candidateText contains markdown code blocks, strip them (even with conversational prelude/coda)
          let cleanJsonText = candidateText.trim();
          const codeBlockMatch = cleanJsonText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
          if (codeBlockMatch) {
            cleanJsonText = codeBlockMatch[1].trim();
          }
          parsedData = JSON.parse(cleanJsonText);
        } catch (_) {
          // Candidate text is unstructured plain text
          parsedData = { text: candidateText };
        }

        if (typeof parsedData === "object" && parsedData !== null) {
          parsedData._modelUsed = model;
        }

        return parsedData;
      } catch (e) {
        if (typeof Logger !== "undefined") {
          Logger.log('[ERROR] Exception calling model "' + model + '": ' + e.toString());
        }
      }
    }

    return null;
  }

  return {
    DEFAULT_MODEL_LADDER: DEFAULT_MODEL_LADDER,
    PRIORITY_MAP: PRIORITY_MAP,
    EXCLUDED_KEYWORDS: EXCLUDED_KEYWORDS,
    isDailyQuotaError: isDailyQuotaError,
    getSecondsUntilUtcMidnight: getSecondsUntilUtcMidnight,
    markModelDailyExhausted: markModelDailyExhausted,
    isModelDailyExhausted: isModelDailyExhausted,
    clearModelBans: clearModelBans,
    discoverAvailableModels: discoverAvailableModels,
    getDynamicModelLadder: getDynamicModelLadder,
    callGeminiAPI: callGeminiAPI
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = GeminiFleet;
}
