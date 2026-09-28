#pragma once

#include "GameFramework/Actor.h"
#include "Character.generated.h"

UCLASS(config = Game, BlueprintType)
class ENGINE_API ACharacter : public AActor
{
	GENERATED_BODY()

public:
	ACharacter();

	/** Make the character jump on the next update. */
	UFUNCTION(BlueprintCallable, Category = Character)
	virtual void Jump();

	UFUNCTION(BlueprintCallable, Category = Character)
	virtual void StopJumping();

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = Character)
	int32 JumpMaxCount = 1;

protected:
	bool CanJumpInternal() const;
};
