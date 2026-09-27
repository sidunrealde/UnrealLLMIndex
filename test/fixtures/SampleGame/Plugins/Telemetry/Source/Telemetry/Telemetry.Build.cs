using UnrealBuildTool;

public class Telemetry : ModuleRules
{
	public Telemetry(ReadOnlyTargetRules Target) : base(Target)
	{
		PublicDependencyModuleNames.AddRange(new string[] { "Core" });
		PrivateDependencyModuleNames.AddRange(new string[] { "CoreUObject", "Engine", "HTTP" });
	}
}
