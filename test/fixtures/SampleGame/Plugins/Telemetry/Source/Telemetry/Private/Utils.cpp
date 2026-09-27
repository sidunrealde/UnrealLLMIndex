#include "Utils.h"

FString FTelemetryUtils::MakeEventName(const FString& Category, const FString& Action)
{
	return Category + TEXT(".") + Action;
}
