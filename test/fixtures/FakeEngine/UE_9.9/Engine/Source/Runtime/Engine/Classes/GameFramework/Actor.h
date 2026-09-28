#pragma once

#include "UObject/Object.h"
#include "Actor.generated.h"

UCLASS(BlueprintType, Blueprintable)
class ENGINE_API AActor : public UObject
{
	GENERATED_BODY()

public:
	/** Called when play begins for this actor. */
	UFUNCTION(BlueprintCallable, Category = "Actor")
	virtual void BeginPlay();

	virtual void Tick(float DeltaSeconds);

	UFUNCTION(BlueprintCallable, meta = (DisplayName = "DestroyActor"))
	virtual void K2_DestroyActor();

protected:
	UPROPERTY(VisibleAnywhere)
	float LifeSpan = 0.f;
};
