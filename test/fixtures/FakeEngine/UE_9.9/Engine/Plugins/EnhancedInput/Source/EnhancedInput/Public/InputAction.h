#pragma once

#include "UObject/Object.h"
#include "InputAction.generated.h"

UCLASS(BlueprintType)
class ENHANCEDINPUT_API UInputAction : public UObject
{
	GENERATED_BODY()

public:
	UPROPERTY(EditAnywhere, Category = Action)
	bool bConsumeInput = true;
};
