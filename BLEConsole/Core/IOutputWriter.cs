using System;

namespace BLEConsole.Core
{
    /// <summary>
    /// Abstraction for console output. Allows for testing and alternative output targets.
    /// </summary>
    public interface IOutputWriter
    {
        void Write(string message);
        void WriteLine(string message);
        void WriteError(string message);
        bool IsRedirected { get; }
    }

    /// <summary>
    /// Console implementation of IOutputWriter.
    /// All output goes through <see cref="OutputSink"/>, which owns the "suppress when redirected"
    /// rule. In MCP bridge mode the sink is replaced, so the historical IsOutputRedirected /
    /// IsInputRedirected guards no longer swallow the messages an agent needs.
    /// </summary>
    public class ConsoleOutputWriter : IOutputWriter
    {
        /// <summary>
        /// False in bridge mode: output is captured and part of the tool result, so there is
        /// nothing to redirect away from.
        /// </summary>
        public bool IsRedirected => OutputSink.Handler == null && Console.IsOutputRedirected;

        public void Write(string message)
        {
            OutputSink.Emit(message, false);
        }

        public void WriteLine(string message)
        {
            OutputSink.Emit(message, true);
        }

        public void WriteError(string message)
        {
            OutputSink.Emit(message, true);
        }

        /// <summary>
        /// Static shortcut for code that has no IOutputWriter at hand (e.g. Utilities).
        /// </summary>
        public static void EmitLine(string message)
        {
            OutputSink.Emit(message, true);
        }
    }
}
