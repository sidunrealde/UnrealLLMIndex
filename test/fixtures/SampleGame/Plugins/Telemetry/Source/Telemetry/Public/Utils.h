#pragma once

#include "CoreMinimal.h"

class TELEMETRY_API FTelemetryUtils
{
public:
	static FString MakeEventName(const FString& Category, const FString& Action);
};
