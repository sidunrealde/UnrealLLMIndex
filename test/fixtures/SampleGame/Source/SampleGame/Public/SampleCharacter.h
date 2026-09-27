// Synthetic fixture covering common Unreal header patterns.

#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Character.h"
#include "SampleCharacter.generated.h"

DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FOnHealthChanged, float, NewHealth);
DECLARE_DELEGATE_RetVal_OneParam(bool, FCanInteract, AActor*);

class UInputAction;

namespace SampleTags
{
	const FName Player = TEXT("Player");
	static constexpr int32 MaxLevel = 99;
}

UENUM(BlueprintType)
enum class ESampleState : uint8
{
	Idle UMETA(DisplayName = "Idle"),
	Running,
	Dead = 5
};

ENUM_CLASS_FLAGS(ESampleState)

USTRUCT(BlueprintType)
struct SAMPLEGAME_API FSampleStats
{
	GENERATED_BODY()

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Stats", meta = (ClampMin = "0"))
	float Health = 100.f;

	UPROPERTY(EditAnywhere, Category = "Stats")
	TMap<FName, TArray<int32>> Inventory;

	bool IsAlive() const { return Health > 0.f; }
};

UINTERFACE(MinimalAPI, meta = (CannotImplementInterfaceInBlueprint))
class USampleInteractable : public UInterface
{
	GENERATED_BODY()
};

class SAMPLEGAME_API ISampleInteractable
{
	GENERATED_BODY()

public:
	virtual void Interact(AActor* Instigator) = 0;
};

/**
 * A character with { braces } and "strings; in comments".
 */
UCLASS(Blueprintable, meta = (BlueprintSpawnableComponent))
class SAMPLEGAME_API ASampleCharacter final : public ACharacter, public ISampleInteractable
{
	GENERATED_BODY()

public:
	ASampleCharacter();

	UFUNCTION(BlueprintCallable, Category = "Sample|Combat")
	void ApplyDamage(float Amount, UPARAM(ref) FSampleStats& InStats);

	virtual void Interact(AActor* Instigator) override;

	UFUNCTION(BlueprintPure)
	FORCEINLINE float GetHealth() const { return Stats.Health; }

	bool operator==(const ASampleCharacter& Other) const;

	UPROPERTY(BlueprintAssignable)
	FOnHealthChanged OnHealthChanged;

protected:
	virtual void BeginPlay() override;

	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "Sample")
	FSampleStats Stats;

private:
	TFunction<void(int32)> Callback;
	int32 Flags : 4;
	FString Greeting = TEXT("Hello; {world}");
	static const TArray<FName> DefaultTags;

	using FTagArray = TArray<FName>;
};
