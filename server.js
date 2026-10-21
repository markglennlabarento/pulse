"use strict";

const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const APP_VERSION = require("./package.json").version;

const ROOT = __dirname;
const DATA_DIRECTORY = path.join(ROOT, ".pulse-data");
const HISTORY_FILE = path.join(DATA_DIRECTORY, "history.json");
const HOST = "127.0.0.1";
const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const SAMPLE_INTERVAL_MS = 2_000;
const HISTORY_INTERVAL_MS = 10_000;
const HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const HISTORY_LIMIT = Math.ceil(HISTORY_RETENTION_MS / HISTORY_INTERVAL_MS);
const GPU_REFRESH_INTERVAL_MS = 10_000;
const ALERT_THRESHOLDS = {
  cpu: 90,
  gpu: 90,
  memory: 90,
  gpuTemperature: 85,
};
const ALERT_CONFIRMATION_MS = 10_000;
const ALERT_HISTORY_LIMIT = 100;
const MAX_HTTP_CLIENTS = 25;
const DXGI_HELPER_SOURCE = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Web.Script.Serialization;
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
public struct PulseDxgiLuid { public uint LowPart; public int HighPart; }
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
public struct PulseDxgiAdapterDescription {
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string Description;
  public uint VendorId;
  public uint DeviceId;
  public uint SubSysId;
  public uint Revision;
  public UIntPtr DedicatedVideoMemory;
  public UIntPtr DedicatedSystemMemory;
  public UIntPtr SharedSystemMemory;
  public PulseDxgiLuid AdapterLuid;
}
[ComImport, Guid("2411e7e1-12ac-4ccf-bd14-9798e8534dc0"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface PulseDxgiAdapter {
  [PreserveSig] int SetPrivateData(ref Guid guid, uint size, IntPtr data);
  [PreserveSig] int SetPrivateDataInterface(ref Guid guid, IntPtr data);
  [PreserveSig] int GetPrivateData(ref Guid guid, ref uint size, IntPtr data);
  [PreserveSig] int GetParent(ref Guid guid, out IntPtr parent);
  [PreserveSig] int EnumOutputs(uint index, out IntPtr output);
  [PreserveSig] int GetDesc(out PulseDxgiAdapterDescription description);
  [PreserveSig] int CheckInterfaceSupport(ref Guid guid, out long version);
}
[ComImport, Guid("7b7166ec-21c7-44ae-b21a-c9ae321ae369"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface PulseDxgiFactory {
  [PreserveSig] int SetPrivateData(ref Guid guid, uint size, IntPtr data);
  [PreserveSig] int SetPrivateDataInterface(ref Guid guid, IntPtr data);
  [PreserveSig] int GetPrivateData(ref Guid guid, ref uint size, IntPtr data);
  [PreserveSig] int GetParent(ref Guid guid, out IntPtr parent);
  [PreserveSig] int EnumAdapters(uint index, out IntPtr adapter);
  [PreserveSig] int MakeWindowAssociation(IntPtr window, uint flags);
  [PreserveSig] int GetWindowAssociation(out IntPtr window);
  [PreserveSig] int CreateSwapChain(IntPtr device, IntPtr description, out IntPtr swapChain);
  [PreserveSig] int CreateSoftwareAdapter(IntPtr module, out IntPtr adapter);
}
public static class PulseDxgiNative {
  [DllImport("dxgi.dll", EntryPoint="CreateDXGIFactory", PreserveSig=true)]
  private static extern int CreateFactory(ref Guid guid, [MarshalAs(UnmanagedType.Interface)] out PulseDxgiFactory factory);
  public static string Enumerate() {
    var adapters = new List<object>();
    PulseDxgiFactory factory;
    Guid guid = new Guid("7b7166ec-21c7-44ae-b21a-c9ae321ae369");
    int result = CreateFactory(ref guid, out factory);
    if (result < 0) Marshal.ThrowExceptionForHR(result);
    try {
      for (uint index = 0; ; index++) {
        IntPtr pointer;
        result = factory.EnumAdapters(index, out pointer);
        if (result == unchecked((int)0x887A0002)) break;
        if (result < 0) Marshal.ThrowExceptionForHR(result);
        PulseDxgiAdapter adapter = null;
        try {
          adapter = (PulseDxgiAdapter)Marshal.GetTypedObjectForIUnknown(pointer, typeof(PulseDxgiAdapter));
          PulseDxgiAdapterDescription description;
          result = adapter.GetDesc(out description);
          if (result < 0) Marshal.ThrowExceptionForHR(result);
          adapters.Add(new {
            name = description.Description,
            vendorId = description.VendorId,
            deviceId = description.DeviceId,
            dedicatedVideoMemoryBytes = description.DedicatedVideoMemory.ToUInt64(),
            sharedSystemMemoryBytes = description.SharedSystemMemory.ToUInt64(),
            luid = String.Format("0x{0:X8}_0x{1:X8}", unchecked((uint)description.AdapterLuid.HighPart), description.AdapterLuid.LowPart)
          });
        } finally {
          if (adapter != null) Marshal.ReleaseComObject(adapter);
          Marshal.Release(pointer);
        }
      }
    } finally {
      if (factory != null) Marshal.ReleaseComObject(factory);
    }
    return new JavaScriptSerializer().Serialize(adapters);
  }
}`;
const AMD_ADL_HELPER_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
[UnmanagedFunctionPointer(CallingConvention.StdCall)]
public delegate IntPtr PulseAdlMemoryAllocate(int size);
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)]
public struct PulseAdlAdapterInfo {
  public int Size;
  public int AdapterIndex;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string UniqueId;
  public int BusNumber;
  public int DeviceNumber;
  public int FunctionNumber;
  public int VendorId;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string AdapterName;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string DisplayName;
  public int Present;
  public int Exists;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string DriverPath;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string DriverPathExtension;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string PnpDeviceId;
  public int OsDisplayIndex;
}
[StructLayout(LayoutKind.Sequential)]
public struct PulseAdlTemperature {
  public int Size;
  public int Temperature;
}
public static class PulseAmdTemperature {
  [DllImport("atiadlxx.dll", CallingConvention=CallingConvention.StdCall)]
  private static extern int ADL_Main_Control_Create(PulseAdlMemoryAllocate callback, int enumerateConnectedAdapters);
  [DllImport("atiadlxx.dll", CallingConvention=CallingConvention.StdCall)]
  private static extern int ADL_Main_Control_Destroy();
  [DllImport("atiadlxx.dll", CallingConvention=CallingConvention.StdCall)]
  private static extern int ADL_Adapter_NumberOfAdapters_Get(ref int count);
  [DllImport("atiadlxx.dll", CallingConvention=CallingConvention.StdCall)]
  private static extern int ADL_Adapter_AdapterInfo_Get(IntPtr info, int inputSize);
  [DllImport("atiadlxx.dll", CallingConvention=CallingConvention.StdCall)]
  private static extern int ADL_Overdrive5_Temperature_Get(int adapterIndex, int thermalControllerIndex, ref PulseAdlTemperature temperature);
  private static readonly PulseAdlMemoryAllocate MemoryAllocate =
    delegate(int size) { return Marshal.AllocHGlobal(size); };

  public static string Read() {
    int status = ADL_Main_Control_Create(MemoryAllocate, 1);
    if (status != 0) throw new InvalidOperationException("ADL initialization failed with code " + status);
    try {
      int count = 0;
      status = ADL_Adapter_NumberOfAdapters_Get(ref count);
      if (status != 0) throw new InvalidOperationException("ADL adapter enumeration failed with code " + status);
      if (count <= 0) return "[]";

      int size = Marshal.SizeOf(typeof(PulseAdlAdapterInfo));
      IntPtr buffer = Marshal.AllocHGlobal(size * count);
      try {
        status = ADL_Adapter_AdapterInfo_Get(buffer, size * count);
        if (status != 0) throw new InvalidOperationException("ADL adapter details failed with code " + status);

        var readings = new List<object>();
        for (int index = 0; index < count; index++) {
          var adapter = (PulseAdlAdapterInfo)Marshal.PtrToStructure(
            IntPtr.Add(buffer, index * size), typeof(PulseAdlAdapterInfo));
          if (adapter.PnpDeviceId == null ||
              !adapter.PnpDeviceId.StartsWith(@"PCI\VEN_1002&", StringComparison.OrdinalIgnoreCase)) continue;

          var temperature = new PulseAdlTemperature();
          temperature.Size = Marshal.SizeOf(typeof(PulseAdlTemperature));
          status = ADL_Overdrive5_Temperature_Get(adapter.AdapterIndex, 0, ref temperature);
          if (status != 0 || temperature.Temperature <= 0) continue;

          readings.Add(new {
            pnpDeviceId = adapter.PnpDeviceId,
            temperatureC = temperature.Temperature / 1000.0
          });
        }
        return new JavaScriptSerializer().Serialize(readings);
      } finally {
        Marshal.FreeHGlobal(buffer);
      }
    } finally {
      ADL_Main_Control_Destroy();
    }
  }
}`;

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

let lastCpuTimes = readCpuTimes();
let latestGpu = null;
let latestGpuError = null;
let latestGpuTemperatureError = null;
let hardware = getBasicHardware();
let metrics = null;
let history = [];
let alerts = [];
let pendingAlertConditions = new Map();
let lastHistorySampleAt = 0;
let gpuQueryInProgress = false;
let persistenceInProgress = false;
let shuttingDown = false;
const eventClients = new Set();

function readCpuTimes() {
  return os.cpus().map((cpu) =>
    Object.values(cpu.times).reduce((total, value) => total + value, 0),
  );
}

function readCpuUsage() {
  const previous = lastCpuTimes;
  const current = readCpuTimes();
  lastCpuTimes = current;

  const totalDelta = current.reduce(
    (total, value, index) => total + Math.max(0, value - (previous[index] || value)),
    0,
  );
  const idleDelta = os.cpus().reduce(
    (total, cpu, index) => total + Math.max(0, cpu.times.idle - getPreviousIdle(index)),
    0,
  );

  if (totalDelta === 0) {
    return 0;
  }
  return round(clamp((1 - idleDelta / totalDelta) * 100, 0, 100), 1);
}

let previousIdleTimes = os.cpus().map((cpu) => cpu.times.idle);

function getPreviousIdle(index) {
  return previousIdleTimes[index] || 0;
}

function updatePreviousIdleTimes() {
  previousIdleTimes = os.cpus().map((cpu) => cpu.times.idle);
}

function getBasicHardware() {
  const cpus = os.cpus();
  const totalMemoryBytes = os.totalmem();
  return {
    id: os.hostname().toLowerCase(),
    hostname: os.hostname(),
    platform: os.platform(),
    operatingSystem: `${os.type()} ${os.release()}`,
    architecture: os.arch(),
    processor: cpus[0]?.model || "Unknown processor",
    logicalCores: cpus.length,
    totalMemoryBytes,
    startedAt: new Date(Date.now() - os.uptime() * 1_000).toISOString(),
  };
}

function round(value, decimalPlaces = 2) {
  const factor = 10 ** decimalPlaces;
  return Math.round(value * factor) / factor;
}

function normalizePowerShellCollection(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) =>
      Array.isArray(item?.value) ? item.value : [item],
    );
  }
  if (Array.isArray(value?.value)) {
    return value.value;
  }
  return value ? [value] : [];
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function runCommand(command, args, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let finished = false;
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    function finish(error, result) {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeout);
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 1_000_000) {
        child.kill();
        finish(new Error(`${command} returned more than 1 MB of output`));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 32_000) {
        stderr = stderr.slice(-32_000);
      }
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      if (code === 0) {
        finish(null, stdout.trim());
      } else {
        const failure = new Error(
          `${command} exited with ${signal ? `signal ${signal}` : `code ${code}`}${
            stderr.trim() ? `: ${stderr.trim()}` : ""
          }`,
        );
        failure.code = code;
        finish(failure);
      }
    });
  });
}

async function runPowerShellJson(script, timeoutMs = 12_000) {
  const encodedScript = Buffer.from(script, "utf16le").toString("base64");
  const output = await runCommand(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encodedScript,
    ],
    timeoutMs,
  );
  if (!output) {
    return null;
  }
  return JSON.parse(output);
}

function parseCsvRow(line) {
  const values = [];
  let field = "";
  let insideQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && line[index + 1] === '"' && insideQuotes) {
      field += '"';
      index += 1;
    } else if (character === '"') {
      insideQuotes = !insideQuotes;
    } else if (character === "," && !insideQuotes) {
      values.push(field.trim());
      field = "";
    } else {
      field += character;
    }
  }
  values.push(field.trim());
  return values;
}

function parseNvidiaOutput(output) {
  const devices = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, utilization, memoryUsed, memoryTotal, temperature] = parseCsvRow(line);
      const parseNumber = (value) => {
        const number = Number.parseFloat(value);
        return Number.isFinite(number) ? number : null;
      };
      return {
        name,
        utilizationPercent: parseNumber(utilization),
        memoryUsedMB: parseNumber(memoryUsed),
        memoryTotalMB: parseNumber(memoryTotal),
        temperatureC: parseNumber(temperature),
      };
    })
    .filter((device) => device.name);

  if (devices.length === 0) {
    throw new Error("nvidia-smi returned no GPU devices");
  }
  return combineGpuDevices(devices, "nvidia-smi");
}

function combineGpuDevices(devices, source) {
  const orderedDevices = [...devices].sort(
    (left, right) =>
      (right.dedicatedVideoMemoryBytes || (right.memoryTotalMB || 0) * 1024 ** 2) -
      (left.dedicatedVideoMemoryBytes || (left.memoryTotalMB || 0) * 1024 ** 2),
  );
  const primary = orderedDevices.find((device) => !device.isSoftware) || orderedDevices[0];

  return {
    name: primary?.name || "GPU unavailable",
    utilizationPercent: primary?.utilizationPercent ?? null,
    temperatureC: primary?.temperatureC ?? null,
    memoryUsedMB: primary?.memoryUsedMB ?? null,
    memoryTotalMB: primary?.memoryTotalMB ?? null,
    isDedicated:
      primary?.isDedicated ??
      (Number.isFinite(primary?.memoryTotalMB) && primary.memoryTotalMB >= 512),
    devices: orderedDevices,
    primaryAdapterLuid: primary?.luid || null,
    source,
  };
}

async function readWindowsGpuMetrics() {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$engines = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine | Select-Object Name,UtilizationPercentage)",
    "$memory = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory | Select-Object Name,DedicatedUsage)",
    "$temperatures = @(); $temperatureError = $null",
    `$adlSource = @'\n${AMD_ADL_HELPER_SOURCE}\n'@`,
    "try { Add-Type -TypeDefinition $adlSource -ReferencedAssemblies System.Web.Extensions -ErrorAction Stop; $temperatures = @([PulseAmdTemperature]::Read() | ConvertFrom-Json) } catch { $temperatureError = $_.Exception.Message }",
    "$result = [pscustomobject]@{ engines = $engines; memory = $memory; temperatures = $temperatures; temperatureError = $temperatureError }",
    "$result | ConvertTo-Json -Compress -Depth 4",
  ].join("\n");
  const result = await runPowerShellJson(script);
  if (!result || !Array.isArray(hardware.graphics) || hardware.graphics.length === 0) {
    throw new Error("Windows GPU counters or adapter details are unavailable");
  }
  const hasAmdAdapter = hardware.graphics.some((adapter) => adapter.vendorId === 0x1002);
  const temperatureError = hasAmdAdapter ? result.temperatureError : null;
  if (temperatureError && temperatureError !== latestGpuTemperatureError) {
    console.error(`[gpu] Could not read AMD GPU temperature: ${temperatureError}`);
  }
  latestGpuTemperatureError = temperatureError || null;

  const engines = normalizePowerShellCollection(result.engines);
  const memoryCounters = normalizePowerShellCollection(result.memory);
  const temperatures = new Map(
    normalizePowerShellCollection(result.temperatures)
      .filter(
        (sensor) =>
          typeof sensor.pnpDeviceId === "string" &&
          typeof sensor.temperatureC === "number" &&
          Number.isFinite(sensor.temperatureC),
      )
      .map((sensor) => [sensor.pnpDeviceId.toLowerCase(), sensor.temperatureC]),
  );
  const devices = hardware.graphics.map((adapter) => {
    const luid = adapter.luid?.toLowerCase();
    const matchingEngines = luid
      ? engines.filter((engine) =>
          new RegExp(`luid_${luid}_phys_\\d+_eng_\\d+_engtype_`, "i").test(engine.Name || ""),
        )
      : [];
    const matchingMemory = luid
      ? memoryCounters.filter((counter) =>
          new RegExp(`^luid_${luid}_phys_\\d+$`, "i").test(counter.Name || ""),
        )
      : [];
    const usages = matchingEngines
      .map((engine) => Number(engine.UtilizationPercentage))
      .filter(Number.isFinite);
    const dedicatedUsage = matchingMemory
      .map((counter) => Number(counter.DedicatedUsage))
      .filter(Number.isFinite);
    const dedicatedMemoryBytes = Number(adapter.dedicatedVideoMemoryBytes);

    return {
      ...adapter,
      utilizationPercent:
        usages.length > 0 ? round(Math.max(...usages), 1) : matchingEngines.length ? 0 : null,
      memoryUsedMB:
        dedicatedUsage.length > 0
          ? round(dedicatedUsage.reduce((sum, value) => sum + value, 0) / (1024 * 1024), 1)
          : null,
      memoryTotalMB:
        Number.isFinite(dedicatedMemoryBytes) && dedicatedMemoryBytes > 0
          ? round(dedicatedMemoryBytes / (1024 * 1024), 1)
          : null,
      temperatureC: temperatures.get(adapter.pnpDeviceId?.toLowerCase()) ?? null,
      isSoftware: adapter.vendorId === 0x1414,
    };
  });

  if (devices.length === 0) {
    throw new Error("Windows did not report any GPU adapters");
  }
  return combineGpuDevices(devices, "windows-performance-counters");
}

async function refreshGpuMetrics() {
  if (gpuQueryInProgress || shuttingDown) {
    return;
  }
  gpuQueryInProgress = true;
  try {
    if (os.platform() === "win32") {
      try {
        const output = await runCommand("nvidia-smi", [
          "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
          "--format=csv,noheader,nounits",
        ]);
        latestGpu = parseNvidiaOutput(output);
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
        latestGpu = await readWindowsGpuMetrics();
      }
    } else {
      latestGpuError =
        "GPU telemetry is currently supported on Windows; this local prototype is Windows-only.";
      return;
    }
    latestGpuError = null;
  } catch (error) {
    latestGpuError = error.message;
    if (latestGpu) {
      latestGpu = { ...latestGpu, error: latestGpuError };
    }
    console.error(`[gpu] ${error.message}`);
  } finally {
    gpuQueryInProgress = false;
  }
}

function formatMetricSnapshot() {
  const cpuPercent = readCpuUsage();
  updatePreviousIdleTimes();
  const totalMemoryBytes = os.totalmem();
  const freeMemoryBytes = os.freemem();
  const usedMemoryBytes = Math.max(0, totalMemoryBytes - freeMemoryBytes);
  const cpu = os.cpus();

  return {
    timestamp: new Date().toISOString(),
    cpu: {
      utilizationPercent: cpuPercent,
      model: hardware.processor,
      logicalCores: hardware.logicalCores,
      speedMHz: cpu[0]?.speed || null,
    },
    gpu: latestGpu
      ? { ...latestGpu, error: latestGpuError }
      : {
          name: hardware.graphics?.map((device) => device.name).join(", ") || null,
          utilizationPercent: null,
          temperatureC: null,
          memoryUsedMB: null,
          memoryTotalMB: null,
          devices: hardware.graphics || [],
          source: null,
          error: latestGpuError || "Waiting for the first GPU telemetry sample.",
        },
    memory: {
      usedBytes: usedMemoryBytes,
      totalBytes: totalMemoryBytes,
      availableBytes: freeMemoryBytes,
      usedGB: round(usedMemoryBytes / 1024 ** 3, 2),
      totalGB: round(totalMemoryBytes / 1024 ** 3, 2),
      utilizationPercent: round((usedMemoryBytes / totalMemoryBytes) * 100, 1),
    },
    uptimeSeconds: Math.floor(os.uptime()),
  };
}

function addAlert({ key, severity, title, message }) {
  const alert = {
    id: randomUUID(),
    key,
    severity,
    title,
    message,
    timestamp: new Date().toISOString(),
    resolvedAt: null,
  };
  alerts.unshift(alert);
  alerts = alerts.slice(0, ALERT_HISTORY_LIMIT);
  broadcast("alert", alert);
}

function resolveActiveAlert(key) {
  const alert = alerts.find((item) => item.key === key && !item.resolvedAt);
  if (alert) {
    alert.resolvedAt = new Date().toISOString();
    broadcast("alert-resolved", alert);
  }
}

function evaluateCondition({ key, active, severity, title, message }) {
  if (!active) {
    pendingAlertConditions.delete(key);
    resolveActiveAlert(key);
    return;
  }
  if (alerts.some((alert) => alert.key === key && !alert.resolvedAt)) {
    return;
  }

  const now = Date.now();
  const pendingSince = pendingAlertConditions.get(key) || now;
  pendingAlertConditions.set(key, pendingSince);
  if (now - pendingSince >= ALERT_CONFIRMATION_MS) {
    pendingAlertConditions.delete(key);
    addAlert({ key, severity, title, message });
  }
}

function evaluateAlerts(snapshot) {
  const gpu = snapshot.gpu;
  evaluateCondition({
    key: "cpu-high",
    active: snapshot.cpu.utilizationPercent >= ALERT_THRESHOLDS.cpu,
    severity: "warning",
    title: "CPU usage is high",
    message: `CPU usage reached ${snapshot.cpu.utilizationPercent}%.`,
  });
  evaluateCondition({
    key: "memory-high",
    active: snapshot.memory.utilizationPercent >= ALERT_THRESHOLDS.memory,
    severity: "warning",
    title: "Memory usage is high",
    message: `Memory usage reached ${snapshot.memory.utilizationPercent}%.`,
  });
  evaluateCondition({
    key: "gpu-high",
    active: Number.isFinite(gpu.utilizationPercent) &&
      gpu.utilizationPercent >= ALERT_THRESHOLDS.gpu,
    severity: "warning",
    title: "GPU usage is high",
    message: `GPU usage reached ${gpu.utilizationPercent}%.`,
  });
  evaluateCondition({
    key: "gpu-temperature",
    active: Number.isFinite(gpu.temperatureC) &&
      gpu.temperatureC >= ALERT_THRESHOLDS.gpuTemperature,
    severity: "critical",
    title: "GPU temperature is critical",
    message: `GPU temperature reached ${gpu.temperatureC}°C.`,
  });
}

function broadcast(event, payload) {
  const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of eventClients) {
    if (!client.destroyed) {
      client.write(message);
    }
  }
}

function sample() {
  if (shuttingDown) {
    return;
  }
  metrics = formatMetricSnapshot();
  evaluateAlerts(metrics);
  broadcast("metrics", metrics);

  const now = Date.now();
  if (now - lastHistorySampleAt >= HISTORY_INTERVAL_MS) {
    history.push({
      timestamp: metrics.timestamp,
      cpu: metrics.cpu.utilizationPercent,
      gpu: metrics.gpu.utilizationPercent,
      memory: metrics.memory.utilizationPercent,
    });
    const retentionCutoff = now - HISTORY_RETENTION_MS;
    history = history
      .filter((point) => Date.parse(point.timestamp) >= retentionCutoff)
      .slice(-HISTORY_LIMIT);
    lastHistorySampleAt = now;
  }
}

async function persistHistory() {
  if (persistenceInProgress) {
    return;
  }
  persistenceInProgress = true;
  const temporaryFile = `${HISTORY_FILE}.${process.pid}.tmp`;
  try {
    await fs.mkdir(DATA_DIRECTORY, { recursive: true });
    await fs.writeFile(temporaryFile, JSON.stringify(history), "utf8");
    await fs.rename(temporaryFile, HISTORY_FILE);
  } catch (error) {
    console.error(`[history] Could not save metrics history: ${error.message}`);
    try {
      await fs.rm(temporaryFile, { force: true });
    } catch (cleanupError) {
      console.error(`[history] Could not clean up temporary history file: ${cleanupError.message}`);
    }
  } finally {
    persistenceInProgress = false;
  }
}

async function loadHistory() {
  try {
    const content = await fs.readFile(HISTORY_FILE, "utf8");
    const savedHistory = JSON.parse(content);
    if (!Array.isArray(savedHistory)) {
      throw new Error("History file must contain a JSON array");
    }
    const cutoff = Date.now() - HISTORY_RETENTION_MS;
    history = savedHistory
      .filter(
        (point) =>
          point &&
          typeof point.timestamp === "string" &&
          Number.isFinite(Date.parse(point.timestamp)) &&
          Date.parse(point.timestamp) >= cutoff,
      )
      .slice(-HISTORY_LIMIT);
    lastHistorySampleAt = Date.now();
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error(`[history] Could not load saved metrics: ${error.message}`);
    }
  }
}

async function loadHardwareDetails() {
  if (os.platform() !== "win32") {
    return;
  }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$graphics = @(Get-CimInstance Win32_VideoController | Where-Object { $_.Name -and $_.Name -notmatch 'Microsoft Basic Display' } | Select-Object Name,PNPDeviceID,AdapterRAM,DriverVersion)",
    "$dxgiAdapters = @(); $dxgiError = $null",
    `$dxgiSource = @'\n${DXGI_HELPER_SOURCE}\n'@`,
    "try { Add-Type -TypeDefinition $dxgiSource -ReferencedAssemblies System.Web.Extensions -ErrorAction Stop; $dxgiAdapters = @([PulseDxgiNative]::Enumerate() | ConvertFrom-Json) } catch { $dxgiError = $_.Exception.Message }",
    "$operatingSystem = (Get-CimInstance Win32_OperatingSystem).Caption",
    "$result = [pscustomobject]@{ graphics = $graphics; operatingSystem = $operatingSystem; dxgiAdapters = $dxgiAdapters; dxgiError = $dxgiError }",
    "$result | ConvertTo-Json -Compress -Depth 3",
  ].join("\n");
  try {
    const result = await runPowerShellJson(script);
    if (typeof result?.operatingSystem === "string" && result.operatingSystem) {
      hardware.operatingSystem = result.operatingSystem;
    }
    const dxgiAdapters = normalizePowerShellCollection(result?.dxgiAdapters);
    if (result?.dxgiError) {
      console.error(`[hardware] Could not map Windows GPU adapter IDs: ${result.dxgiError}`);
    }
    if (result?.graphics) {
      const devices = normalizePowerShellCollection(result.graphics);
      hardware.graphics = devices
        .map((device) => {
          const pnpId =
            /VEN_([0-9A-F]{4})&DEV_([0-9A-F]{4})/i.exec(device.PNPDeviceID || "") || [];
          const dxgi = dxgiAdapters.find(
            (adapter) =>
              Number(adapter.vendorId) === Number.parseInt(pnpId[1], 16) &&
              Number(adapter.deviceId) === Number.parseInt(pnpId[2], 16),
          );
          const dedicatedVideoMemoryBytes = Number(dxgi?.dedicatedVideoMemoryBytes);
          const memoryBytes =
            Number.isFinite(dedicatedVideoMemoryBytes) && dedicatedVideoMemoryBytes > 0
              ? dedicatedVideoMemoryBytes
              : null;
          return {
            name: device.Name || dxgi?.name || "Unknown graphics adapter",
            memoryBytes,
            dedicatedVideoMemoryBytes: memoryBytes,
            sharedSystemMemoryBytes: Number(dxgi?.sharedSystemMemoryBytes) || null,
            driverVersion: device.DriverVersion || null,
            pnpDeviceId: device.PNPDeviceID || null,
            luid: typeof dxgi?.luid === "string" ? dxgi.luid : null,
            vendorId: Number(dxgi?.vendorId) || null,
            deviceId: Number(dxgi?.deviceId) || null,
            isDedicated: Boolean(memoryBytes && memoryBytes >= 512 * 1024 ** 2),
          };
        })
        .sort((left, right) => (right.memoryBytes || 0) - (left.memoryBytes || 0));
    } else {
      hardware.graphics = [];
    }
  } catch (error) {
    hardware.graphics = [];
    console.error(`[hardware] Could not read Windows GPU adapter details: ${error.message}`);
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

function getRequestOrigin(request) {
  const host = request.headers.host || "";
  const hostname = host.startsWith("[")
    ? host.slice(1, host.indexOf("]"))
    : host.split(":")[0];
  if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) {
    return null;
  }
  return `http://${host}`;
}

function isAllowedRequest(request) {
  const origin = getRequestOrigin(request);
  if (!origin) {
    return false;
  }
  const requestOrigin = request.headers.origin;
  if (!requestOrigin || requestOrigin === "null") {
    return true;
  }
  return requestOrigin === origin;
}

function rangeMilliseconds(value) {
  const ranges = new Map([
    ["1h", 60 * 60 * 1_000],
    ["6h", 6 * 60 * 60 * 1_000],
    ["24h", 24 * 60 * 60 * 1_000],
    ["7d", 7 * 24 * 60 * 60 * 1_000],
  ]);
  return ranges.get(value) || ranges.get("6h");
}

function handleEvents(request, response) {
  if (eventClients.size >= MAX_HTTP_CLIENTS) {
    sendJson(response, 503, { error: "Maximum live dashboard connections reached." });
    return;
  }
  response.writeHead(200, {
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream; charset=utf-8",
    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff",
  });
  response.write("retry: 3000\n\n");
  eventClients.add(response);
  if (metrics) {
    response.write(`event: metrics\ndata: ${JSON.stringify(metrics)}\n\n`);
  }
  response.write(`event: alerts\ndata: ${JSON.stringify(alerts)}\n\n`);
  const heartbeat = setInterval(() => {
    if (!response.destroyed) {
      response.write(": heartbeat\n\n");
    }
  }, 20_000);
  request.on("close", () => {
    clearInterval(heartbeat);
    eventClients.delete(response);
  });
}

function contentSecurityPolicy() {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

async function serveStaticFile(request, response, url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    sendJson(response, 400, { error: "Invalid URL path." });
    return;
  }
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!["index.html", "styles.css", "app.js"].includes(relativePath)) {
    sendJson(response, 404, { error: "File not found." });
    return;
  }
  const resolvedPath = path.resolve(ROOT, relativePath);
  if (
    resolvedPath !== ROOT &&
    !resolvedPath.startsWith(`${ROOT}${path.sep}`)
  ) {
    sendJson(response, 403, { error: "Access to this path is not allowed." });
    return;
  }
  if (resolvedPath.startsWith(`${DATA_DIRECTORY}${path.sep}`)) {
    sendJson(response, 404, { error: "File not found." });
    return;
  }

  let body;
  try {
    body = await fs.readFile(resolvedPath);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") {
      sendJson(response, 404, { error: "File not found." });
      return;
    }
    throw error;
  }

  const contentType =
    MIME_TYPES.get(path.extname(resolvedPath).toLowerCase()) ||
    "application/octet-stream";
  response.writeHead(200, {
    "Cache-Control": "no-cache",
    "Content-Length": body.length,
    "Content-Security-Policy": contentSecurityPolicy(),
    "Content-Type": contentType,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  if (request.method === "HEAD") {
    response.end();
  } else {
    response.end(body);
  }
}

const server = http.createServer(async (request, response) => {
  if (!["GET", "HEAD"].includes(request.method)) {
    sendJson(response, 405, { error: "Only GET and HEAD requests are supported." });
    return;
  }
  if (!isAllowedRequest(request)) {
    sendJson(response, 403, { error: "Requests must come from this local dashboard." });
    return;
  }

  const url = new URL(request.url || "/", `http://${request.headers.host}`);
  try {
    if (url.pathname === "/api/health") {
      sendJson(response, 200, {
        status: "ok",
        version: APP_VERSION,
        hostname: hardware.hostname,
        timestamp: new Date().toISOString(),
      });
    } else if (url.pathname === "/api/device") {
      sendJson(response, 200, hardware);
    } else if (url.pathname === "/api/metrics") {
      if (!metrics) {
        sendJson(response, 503, { error: "System metrics are not ready yet." });
      } else {
        sendJson(response, 200, metrics);
      }
    } else if (url.pathname === "/api/history") {
      const cutoff = Date.now() - rangeMilliseconds(url.searchParams.get("range"));
      sendJson(response, 200, {
        range: url.searchParams.get("range") || "6h",
        points: history.filter((point) => Date.parse(point.timestamp) >= cutoff),
        sampledEverySeconds: HISTORY_INTERVAL_MS / 1_000,
      });
    } else if (url.pathname === "/api/alerts") {
      const limit = clamp(
        Number.parseInt(url.searchParams.get("limit") || "20", 10) || 20,
        1,
        ALERT_HISTORY_LIMIT,
      );
      sendJson(response, 200, {
        alerts: alerts.slice(0, limit),
        activeCount: alerts.filter((alert) => !alert.resolvedAt).length,
      });
    } else if (url.pathname === "/api/events") {
      handleEvents(request, response);
    } else if (url.pathname.startsWith("/api/")) {
      sendJson(response, 404, { error: "API endpoint not found." });
    } else {
      await serveStaticFile(request, response, url);
    }
  } catch (error) {
    console.error(`[http] ${request.method} ${url.pathname}: ${error.message}`);
    if (!response.headersSent) {
      sendJson(response, 500, { error: "An internal server error occurred." });
    } else {
      response.destroy(error);
    }
  }
});

server.maxConnections = MAX_HTTP_CLIENTS + 25;
server.requestTimeout = 10_000;
server.headersTimeout = 12_000;
server.keepAliveTimeout = 5_000;

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`\n[server] Received ${signal}; shutting down.`);
  clearInterval(sampleTimer);
  clearInterval(gpuTimer);
  clearInterval(persistTimer);
  for (const client of eventClients) {
    client.end();
  }
  eventClients.clear();
  await persistHistory();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}

async function start() {
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  await fs.mkdir(DATA_DIRECTORY, { recursive: true });
  await loadHistory();
  await loadHardwareDetails();
  await refreshGpuMetrics();
  sample();

  server.listen(PORT, HOST, () => {
    console.log(`[server] Pulse dashboard: http://${HOST}:${PORT}`);
    console.log(`[server] Monitoring ${hardware.hostname} (${hardware.platform}).`);
    console.log(`[server] Sampling every ${SAMPLE_INTERVAL_MS / 1_000}s; history retained for 7 days.`);
    if (hardware.graphics?.length) {
      console.log(`[gpu] Detected ${hardware.graphics.map((device) => device.name).join(", ")}.`);
    }
    if (latestGpuError) {
      console.error(`[gpu] ${latestGpuError}`);
    }
  });

  sampleTimer = setInterval(sample, SAMPLE_INTERVAL_MS);
  gpuTimer = setInterval(refreshGpuMetrics, GPU_REFRESH_INTERVAL_MS);
  persistTimer = setInterval(persistHistory, 60_000);
}

let sampleTimer;
let gpuTimer;
let persistTimer;

server.on("error", (error) => {
  console.error(`[server] ${error.message}`);
  process.exit(1);
});
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

start().catch((error) => {
  console.error(`[startup] ${error.stack || error.message}`);
  process.exitCode = 1;
});
