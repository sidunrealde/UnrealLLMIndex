#include "SampleCharacter.h"

const TArray<FName> ASampleCharacter::DefaultTags = { TEXT("A"), TEXT("B") };

namespace
{
	float Clamp01(float Value)
	{
		return FMath::Clamp(Value, 0.f, 1.f);
	}
}

ASampleCharacter::ASampleCharacter()
	: Flags(0)
{
	PrimaryActorTick.bCanEverTick = true;
}

void ASampleCharacter::ApplyDamage(float Amount, FSampleStats& InStats)
{
	if (Amount > 0.f)
	{
		InStats.Health -= Clamp01(Amount);
		OnHealthChanged.Broadcast(InStats.Health);
	}
	const FString Msg = TEXT("}"); // a brace inside a string must not end the function
}

void ASampleCharacter::Interact(AActor* Instigator)
{
	UE_LOG(LogTemp, Log, TEXT("Interact { %s"), *GetNameSafe(Instigator));
}

bool ASampleCharacter::operator==(const ASampleCharacter& Other) const
{
	return this == &Other;
}

void ASampleCharacter::BeginPlay()
{
	Super::BeginPlay();
	auto Lambda = [this](int32 X) { return X * 2; };
	Lambda(1);
}
