"use strict";

window.PulseUtils = Object.freeze({
  formatNumber(value, maximumFractionDigits = 1) {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(value);
  },

  formatDuration(totalSeconds) {
    const days = Math.floor(totalSeconds / 86_400);
    const hours = Math.floor((totalSeconds % 86_400) / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    return `${days}d ${hours}h ${minutes}m`;
  },

  formatTime(timestamp) {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(timestamp));
  },

  formatRelativeTime(timestamp) {
    const elapsedSeconds = Math.max(0, Math.round((Date.now() - Date.parse(timestamp)) / 1_000));
    if (elapsedSeconds < 5) {
      return "just now";
    }
    if (elapsedSeconds < 60) {
      return `${elapsedSeconds} seconds ago`;
    }
    const minutes = Math.floor(elapsedSeconds / 60);
    if (minutes < 60) {
      return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
    }
    return `${Math.floor(minutes / 60)} hours ago`;
  },

  setText(element, value) {
    if (element) {
      element.textContent = value;
    }
  },

  formatGraphicsSummary(graphics) {
    if (!Array.isArray(graphics) || graphics.length === 0) {
      return "GPU information unavailable";
    }
    return graphics
      .map((gpu) => `${gpu.name} (${gpu.isDedicated ? "Dedicated" : "Integrated"})`)
      .join(" · ");
  },
});
