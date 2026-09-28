#include "Math/UnrealMathUtility.h"

float FMath::Clamp01(float X)
{
	return X < 0.f ? 0.f : (X > 1.f ? 1.f : X);
}
