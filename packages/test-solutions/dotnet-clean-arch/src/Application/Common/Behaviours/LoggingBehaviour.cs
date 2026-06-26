using System.Diagnostics;
using MediatR;
using Microsoft.Extensions.Logging;

namespace CleanArchitecture.Application.Common.Behaviours;

public class LoggingBehaviour<TRequest, TResponse> : IPipelineBehavior<TRequest, TResponse>
    where TRequest : notnull
{
    private readonly ILogger<LoggingBehaviour<TRequest, TResponse>> _logger;

    public LoggingBehaviour(ILogger<LoggingBehaviour<TRequest, TResponse>> logger)
    {
        _logger = logger;
    }

    public async Task<TResponse> Handle(
        TRequest request,
        RequestHandlerDelegate<TResponse> next,
        CancellationToken cancellationToken)
    {
        var requestName = typeof(TRequest).Name;
        var requestId = Guid.NewGuid().ToString();

        _logger.LogInformation(
            "Handling {RequestName} [{RequestId}] at {Timestamp}",
            requestName,
            requestId,
            DateTime.UtcNow);

        LogRequestProperties(request, requestName);

        var stopwatch = Stopwatch.StartNew();

        try
        {
            var response = await next();

            stopwatch.Stop();

            _logger.LogInformation(
                "Handled {RequestName} [{RequestId}] in {ElapsedMilliseconds}ms",
                requestName,
                requestId,
                stopwatch.ElapsedMilliseconds);

            if (stopwatch.ElapsedMilliseconds > 500)
            {
                _logger.LogWarning(
                    "Long running request: {RequestName} [{RequestId}] took {ElapsedMilliseconds}ms",
                    requestName,
                    requestId,
                    stopwatch.ElapsedMilliseconds);
            }

            return response;
        }
        catch (Exception ex)
        {
            stopwatch.Stop();

            _logger.LogError(
                ex,
                "Error handling {RequestName} [{RequestId}] after {ElapsedMilliseconds}ms: {ErrorMessage}",
                requestName,
                requestId,
                stopwatch.ElapsedMilliseconds,
                ex.Message);

            throw;
        }
    }

    private void LogRequestProperties(TRequest request, string requestName)
    {
        try
        {
            var properties = typeof(TRequest).GetProperties();
            var propertyValues = properties
                .Where(p => !p.Name.Contains("Password", StringComparison.OrdinalIgnoreCase) &&
                           !p.Name.Contains("Secret", StringComparison.OrdinalIgnoreCase) &&
                           !p.Name.Contains("Token", StringComparison.OrdinalIgnoreCase))
                .Select(p => $"{p.Name}={p.GetValue(request)}")
                .ToList();

            if (propertyValues.Any())
            {
                _logger.LogDebug(
                    "Request {RequestName} properties: {Properties}",
                    requestName,
                    string.Join(", ", propertyValues));
            }
        }
        catch (Exception ex)
        {
            _logger.LogDebug(
                ex,
                "Could not log properties for {RequestName}",
                requestName);
        }
    }
}
