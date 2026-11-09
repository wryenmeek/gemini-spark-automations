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

  /**
   * Removes existing project triggers matching a specific handler name or list of handler names.
   * If handlerNames is omitted or null, deletes all triggers for the project.
   *
   * @param {string|Array<string>} [handlerNames] - Handler function name(s) to remove
   * @returns {number} Number of deleted triggers
   */
  function clearTriggers(handlerNames) {
    if (typeof ScriptApp === "undefined" || typeof ScriptApp.getProjectTriggers !== "function") {
      return 0;
    }
    const names = Array.isArray(handlerNames)
      ? handlerNames
      : (typeof handlerNames === "string" && handlerNames ? [handlerNames] : null);

    const triggers = ScriptApp.getProjectTriggers();
    let deletedCount = 0;

    for (let i = 0; i < triggers.length; i++) {
      const t = triggers[i];
      const fn = typeof t.getHandlerFunction === "function" ? t.getHandlerFunction() : null;
      if (!names || (fn && names.indexOf(fn) !== -1)) {
        if (typeof ScriptApp.deleteTrigger === "function") {
          ScriptApp.deleteTrigger(t);
          deletedCount++;
        }
      }
    }

    return deletedCount;
  }

  /**
   * Installs an idempotent daily recurring trigger at the specified UTC hour and minute.
   * Automatically clears existing triggers for the handler before creating the new one.
   *
   * @param {string} handlerName - Name of the Apps Script entry function
   * @param {number} [hour=8] - Target hour (0-23)
   * @param {number} [minute=0] - Target minute (0-59)
   * @returns {Object|null} Created trigger object
   */
  function installDailyTrigger(handlerName, hour, minute) {
    if (typeof ScriptApp === "undefined" || typeof ScriptApp.newTrigger !== "function") {
      return null;
    }
    clearTriggers(handlerName);
    hour = typeof hour === "number" ? hour : 8;
    minute = typeof minute === "number" ? minute : 0;

    const trigger = ScriptApp.newTrigger(handlerName)
      .timeBased()
      .everyDays(1)
      .atHour(hour)
      .nearMinute(minute)
      .create();

    if (typeof Logger !== "undefined") {
      const minStr = minute < 10 ? "0" + minute : String(minute);
      Logger.log("[SUCCESS] Installed daily trigger for " + handlerName + " at " + hour + ":" + minStr);
    }

    return trigger;
  }

  /**
   * Installs an idempotent minute-interval recurring trigger.
   * Automatically clears existing triggers for the handler before creating the new one.
   *
   * @param {string} handlerName - Name of the Apps Script entry function
   * @param {number} [intervalMinutes=30] - Interval in minutes (1, 5, 10, 15, 30)
   * @returns {Object|null} Created trigger object
   */
  function installIntervalTrigger(handlerName, intervalMinutes) {
    if (typeof ScriptApp === "undefined" || typeof ScriptApp.newTrigger !== "function") {
      return null;
    }
    clearTriggers(handlerName);
    intervalMinutes = typeof intervalMinutes === "number" ? intervalMinutes : 30;

    const trigger = ScriptApp.newTrigger(handlerName)
      .timeBased()
      .everyMinutes(intervalMinutes)
      .create();

    if (typeof Logger !== "undefined") {
      Logger.log("[SUCCESS] Installed " + intervalMinutes + "-minute recurring time trigger for " + handlerName);
    }

    return trigger;
  }

  /**
   * Installs an idempotent weekly recurring trigger on the specified weekday.
   * Automatically clears existing triggers for the handler before creating the new one.
   *
   * @param {string} handlerName - Name of the Apps Script entry function
   * @param {Object} [dayOfWeek] - ScriptApp.WeekDay value (defaults to MONDAY)
   * @param {number} [hour=9] - Target hour (0-23)
   * @returns {Object|null} Created trigger object
   */
  function installWeeklyTrigger(handlerName, dayOfWeek, hour) {
    if (typeof ScriptApp === "undefined" || typeof ScriptApp.newTrigger !== "function") {
      return null;
    }
    clearTriggers(handlerName);
    hour = typeof hour === "number" ? hour : 9;
    const defaultDay = (typeof ScriptApp !== "undefined" && ScriptApp.WeekDay && ScriptApp.WeekDay.MONDAY)
      ? ScriptApp.WeekDay.MONDAY
      : dayOfWeek;
    const day = dayOfWeek || defaultDay;

    const trigger = ScriptApp.newTrigger(handlerName)
      .timeBased()
      .onWeekDay(day)
      .atHour(hour)
      .create();

    if (typeof Logger !== "undefined") {
      Logger.log("[SUCCESS] Installed weekly trigger for " + handlerName + " on " + day + " at " + hour + ":00");
    }

    return trigger;
  }

  /**
   * Dispatches an actionable task alert to Google Tasks, with optional fallback email notification.
   *
   * @param {string} title - Task title
   * @param {string} [notes] - Detailed notes or error body
   * @param {Object} [options] - Configuration options { taskListId, dueDays, dueIsoString, fallbackEmail }
   * @returns {Object|null} Created task resource or null
   */
  function createTaskAlert(title, notes, options) {
    options = options || {};
    const taskListId = options.taskListId || "@default";

    try {
      if (typeof Tasks !== "undefined" && Tasks.newTask && Tasks.Tasks && typeof Tasks.Tasks.insert === "function") {
        const task = Tasks.newTask();
        task.title = title || "System Alert";
        task.notes = notes || "";
        if (options.dueIsoString) {
          task.due = options.dueIsoString;
        } else if (typeof options.dueDays === "number") {
          const d = new Date();
          d.setDate(d.getDate() + options.dueDays);
          task.due = d.toISOString();
        }
        const created = Tasks.Tasks.insert(task, taskListId);
        if (typeof Logger !== "undefined") {
          Logger.log("[SUCCESS] Created Google Task alert: " + title);
        }
        return created;
      }
    } catch (err) {
      if (typeof Logger !== "undefined") {
        Logger.log("[WARN] Google Tasks API alert failed: " + err.toString());
      }
    }

    if (options.fallbackEmail) {
      sendEmailDigest({
        recipient: options.fallbackEmail,
        subject: "[ALERT] " + (title || "System Alert"),
        body: notes || "No additional details provided."
      });
    }

    return null;
  }

  /**
   * Sends an email digest via GmailApp or MailApp with robust error handling.
   *
   * @param {Object} options - { recipient, subject, body, htmlBody, cc, bcc, name }
   * @returns {boolean} True if sent successfully, false otherwise
   */
  function sendEmailDigest(options) {
    if (!options || !options.recipient || !options.subject) return false;
    const recipient = options.recipient;
    const subject = options.subject;
    const body = options.body || "";
    const emailOptions = {};
    if (options.htmlBody) emailOptions.htmlBody = options.htmlBody;
    if (options.cc) emailOptions.cc = options.cc;
    if (options.bcc) emailOptions.bcc = options.bcc;
    if (options.name) emailOptions.name = options.name;

    try {
      if (typeof GmailApp !== "undefined" && typeof GmailApp.sendEmail === "function") {
        GmailApp.sendEmail(recipient, subject, body, emailOptions);
        return true;
      } else if (typeof MailApp !== "undefined" && typeof MailApp.sendEmail === "function") {
        MailApp.sendEmail(recipient, subject, body, emailOptions);
        return true;
      }
    } catch (e) {
      if (typeof Logger !== "undefined") {
        Logger.log("[ERROR] sendEmailDigest failed: " + e.toString());
      }
    }
    return false;
  }

  return {
    DEFAULT_MAX_RUNTIME_MS: DEFAULT_MAX_RUNTIME_MS,
    createExecutionBudget: createExecutionBudget,
    dispatchError: dispatchError,
    safeExecute: safeExecute,
    clearTriggers: clearTriggers,
    installDailyTrigger: installDailyTrigger,
    installIntervalTrigger: installIntervalTrigger,
    installWeeklyTrigger: installWeeklyTrigger,
    createTaskAlert: createTaskAlert,
    sendEmailDigest: sendEmailDigest
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = Harness;
}
