using System;
using System.Collections.Generic;
using System.Text;

namespace BLEConsole.Core
{
    /// <summary>
    /// Single output funnel for the whole application.
    /// In interactive mode it suppresses output when the console is redirected (legacy behavior).
    /// In MCP bridge mode the bridge installs <see cref="Handler"/>, so every message - including
    /// the ones that used to be guarded by Console.IsInputRedirected / IsOutputRedirected - is
    /// captured and shipped to the MCP server instead of being dropped.
    /// </summary>
    public static class OutputSink
    {
        /// <summary>True when running as the MCP bridge (all output must go through the handler).</summary>
        public static bool IsBridgeMode { get; internal set; }

        /// <summary>Custom sink installed by the MCP bridge. When null, output falls back to the console.</summary>
        public static Action<string> Handler { get; set; }

        /// <summary>
        /// Emit a line (or a fragment) of text. asLine = false means the caller supplied its own
        /// trailing newline, exactly like Console.Write does.
        /// </summary>
        public static void Emit(string message, bool asLine)
        {
            var text = asLine ? (message ?? string.Empty) + Environment.NewLine : (message ?? string.Empty);

            var handler = Handler;
            if (handler != null)
            {
                handler(text);
                return;
            }

            // Interactive mode: keep the original "stay quiet when redirected" behavior.
            if (!Console.IsOutputRedirected)
                Console.Write(text);
        }

        /// <summary>Line-buffered collector used by the MCP bridge to capture one command's output.</summary>
        public sealed class LineCollector
        {
            private readonly List<string> _lines = new List<string>();
            private readonly StringBuilder _pending = new StringBuilder();

            public void Append(string text)
            {
                if (string.IsNullOrEmpty(text)) return;

                int start = 0;
                while (start < text.Length)
                {
                    int nl = text.IndexOf('\n', start);
                    if (nl < 0)
                    {
                        _pending.Append(text, start, text.Length - start);
                        break;
                    }

                    _pending.Append(text, start, nl - start);
                    FlushPending();
                    start = nl + 1;
                }
            }

            /// <summary>Flush trailing text that had no newline (e.g. a "print" without newline).</summary>
            public void FlushPending()
            {
                var line = _pending.ToString().TrimEnd('\r');
                _pending.Clear();
                _lines.Add(line);
            }

            public List<string> Lines()
            {
                if (_pending.Length > 0) FlushPending();
                var result = new List<string>(_lines);
                _lines.Clear();
                return result;
            }
        }
    }
}
