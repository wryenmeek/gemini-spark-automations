/**
 * Harness.js — Execution Timer Budget Supervision & Error Dispatching
 * Part of SparkCore (Google Apps Script Shared Library)
 *
 * Prevents abrupt execution aborts at Google Apps Script's 6-minute (360s) ceiling,
 * provides granular runtime budgets (default: 4 minutes / 240s), and dispatches
 * structured error notifications.
 */

var Harness = (function() {
  const DEFAULT_MAX_RUNTIME_MS = 240000; // 4 minutes

  /**
   * Creates an execution runtime supervisor that tracks elapsed time and signals
   * when execution must yield before hitting Google's hard 6-minute limit.
   *
   * @param {number} maxRunTimeMs - Execution budget in milliseconds (default: 240,000 ms)
   * @returns {Object} Budget supervisor instance
   */
  function createExecutionBudget(maxRunTimeMs) {
    const budget = typeof maxRunTimeMs === "number" ? maxRunTimeMs : DEFAULT_MAX_RUNTIME_MS;
    const startTime = Date.now();

    return {
      startTime: startTime,
      maxRunTimeMs: budget,

      isTimeExpiring: function() {
        return (Date.now() - startTime) >= budget;
      },

      getElapsedMs: function() {
        return Date.now() - startTime;
      },

      getRemainingMs: function() {
        return Math.max(0, budget - (Date.now() - startTime));
      },

      logProgress: function(stage, processed, total) {
        const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
        const remSec = (Math.max(0, budget - (Date.now() - startTime)) / 1000).toFixed(1);
        const totalStr = typeof total === "number" ? " / " + total : "";
        if (typeof Logger !== "undefined") {
          Logger.log("[" + stage + "] Processed " + processed + totalStr + " (" + elapsedSec + "s elapsed, " + remSec + "s budget remaining)");
        }
      }
    };
  }

  /**
   * Dispatches a structured error report to Logger and optionally to email.
   *
   * @param {string} contextName - Pipeline or function name where error occurred
   * @param {Error|string} error - The error object or message
   * @param {Object} options - Optional configuration { notificationEmail: string, silent: boolean }
   * @returns {string} Formatted error log string
   */
  function dispatchError(contextName, error, options) {
    options = options || {};
    const timestamp = new Date().toISOString();
    const errMsg = error && error.message ? error.message : String(error);
    const errStack = error && error.stack ? error.stack : "No stack trace available";

    const formattedLog = [
      "============================================================",
      "[PIPELINE_ERROR] " + contextName + " (" + timestamp + ")",
      "Message: " + errMsg,
      "Stack:   " + errStack,
      "============================================================"
    ].join("\n");

    if (!options.silent && typeof Logger !== "undefined") {
      Logger.log(formattedLog);
    }

    if (options.notificationEmail) {
      try {
        const subject = "[ALERT] Pipeline Error: " + contextName;
        if (typeof MailApp !== "undefined" && typeof MailApp.sendEmail === "function") {
          MailApp.sendEmail(options.notificationEmail, subject, formattedLog);
        } else if (typeof GmailApp !== "undefined" && typeof GmailApp.sendEmail === "function") {
          GmailApp.sendEmail(options.notificationEmail, subject, formattedLog);
        }
      } catch (mailErr) {
        if (typeof Logger !== "undefined") {
          Logger.log("[WARN] Failed to send error notification email: " + mailErr.toString());
        }
      }
    }

    return formattedLog;
  }

  /**
   * Safely wraps a function execution with the error dispatcher.
   */
  function safeExecute(contextName, fn, fallbackValue, options) {
    try {
      return fn();
    } catch (e) {
      dispatchError(contextName, e, options);
      return fallbackValue;
    }
  }

  return {
    DEFAULT_MAX_RUNTIME_MS: DEFAULT_MAX_RUNTIME_MS,
    createExecutionBudget: createExecutionBudget,
    dispatchError: dispatchError,
    safeExecute: safeExecute
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = Harness;
}
