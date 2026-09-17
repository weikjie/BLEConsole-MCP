using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Windows.Devices.Bluetooth.GenericAttributeProfile;

namespace BLEConsole.Core
{
    /// <summary>
    /// MCP bridge transport. Speaks newline-delimited JSON on stdin/stdout so that an MCP server
    /// process can drive the very same command set the interactive console exposes.
    ///
    /// Request  {"id":1,"cmd":"read","args":"#0"}
    /// Response {"id":1,"ok":true,"exit":0,"lines":["Read 4 bytes.","hex: 01 02 03 04"]}
    /// Event    {"notify":"value","char":"...","len":4,"data":"hex: 01 02 03 04"}
    ///
    /// This class only transports; it knows nothing about MCP semantics.
    /// </summary>
    internal static class McpBridge
    {
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
        private static readonly object WriteLock = new object();
        private static readonly OutputSink.LineCollector Collector = new OutputSink.LineCollector();
        private static StreamWriter _stdout;
        private static int _commandThreadId;

        public static async Task RunAsync(Func<string, string, Task> handleSwitch)
        {
            // Everything the app prints lands in the collector and becomes part of the response.
            OutputSink.Handler = Collector.Append;

            var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            _stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };

            bool quit = false;
            try
            {
                raw(ToJson(new Dictionary<string, object>
                {
                    { "ready", true },
                    { "mode", "mcp" },
                    { "pid", System.Diagnostics.Process.GetCurrentProcess().Id },
                }));

                string line;
                while (!quit && (line = await stdin.ReadLineAsync()) != null)
                {
                    if (string.IsNullOrWhiteSpace(line)) continue;

                    Dictionary<string, object> request;
                    try
                    {
                        request = Json.Deserialize<Dictionary<string, object>>(line);
                    }
                    catch (Exception ex)
                    {
                        raw(ToJson(new Dictionary<string, object>
                        {
                            { "id", null }, { "ok", false }, { "exit", 1 },
                            { "error", "Malformed JSON request: " + ex.Message },
                        }));
                        continue;
                    }

                    object id = request.ContainsKey("id") ? request["id"] : null;
                    string command = (request.ContainsKey("cmd") ? request["cmd"] as string : null) ?? string.Empty;
                    string args = (request.ContainsKey("args") ? request["args"] as string : null) ?? string.Empty;

                    if (string.IsNullOrWhiteSpace(command))
                    {
                        raw(ToJson(new Dictionary<string, object>
                        {
                            { "id", id }, { "ok", false }, { "exit", 1 }, { "error", "Missing 'cmd'." },
                        }));
                        continue;
                    }

                    string error = null;
                    _commandThreadId = Thread.CurrentThread.ManagedThreadId;
                    try
                    {
                        await handleSwitch(command, args);
                    }
                    catch (Exception ex)
                    {
                        error = ex.Message;
                    }

                    var response = new Dictionary<string, object>
                    {
                        { "id", id },
                        { "ok", error == null },
                        { "exit", error == null ? 0 : 1 },
                        { "lines", Collector.Lines() },
                    };
                    if (error != null) response["error"] = error;

                    raw(ToJson(response));

                    if (command.Equals("quit", StringComparison.OrdinalIgnoreCase) ||
                        command.Equals("q", StringComparison.OrdinalIgnoreCase))
                        quit = true;
                }
            }
            finally
            {
                OutputSink.Handler = null;
                Collector.FlushPending();
                try { _stdout.Flush(); } catch { }
            }
        }

        /// <summary>Write one JSON message; the single writer keeps responses and events from interleaving.</summary>
        private static void raw(string json)
        {
            lock (WriteLock)
            {
                try
                {
                    _stdout.Write(json);
                    _stdout.Write('\n');
                    _stdout.Flush();
                }
                catch
                {
                    // Pipe is gone; the read loop will end and the process will exit.
                }
            }
        }

        /// <summary>
        /// Pushes a GATT notification as an out-of-band event. Notifications fired by the BLE stack
        /// arrive on a different thread than the command being executed; on the (rare) same-thread
        /// case the value would only be reachable through the response, so it is emitted too - a
        /// duplicate is harmless for the consumer.
        /// </summary>
        public static void EmitNotification(GattCharacteristic sender, GattValueChangedEventArgs args, string formatted)
        {
            raw(ToJson(new Dictionary<string, object>
            {
                { "notify", "value" },
                { "char", sender != null ? sender.Uuid.ToString() : null },
                { "len", args != null && args.CharacteristicValue != null ? args.CharacteristicValue.Length : 0 },
                { "data", formatted },
                { "inCommand", Thread.CurrentThread.ManagedThreadId == _commandThreadId },
            }));
        }

        private static string ToJson(object value)
        {
            lock (Json)
            {
                return Json.Serialize(value);
            }
        }
    }
}
