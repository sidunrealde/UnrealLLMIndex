#include "GameFramework/Character.h"

ACharacter::ACharacter()
{
}

void ACharacter::Jump()
{
	bPressedJump = true;
	JumpKeyHoldTime = 0.0f;
}

void ACharacter::StopJumping()
{
	bPressedJump = false;
}

bool ACharacter::CanJumpInternal() const
{
	return JumpMaxCount > 0;
}
