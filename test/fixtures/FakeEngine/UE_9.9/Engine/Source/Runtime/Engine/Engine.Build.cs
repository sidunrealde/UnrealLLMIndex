public class Engine : ModuleRules
{
	public Engine(ReadOnlyTargetRules Target) : base(Target)
	{
		PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject" });
		PrivateDependencyModuleNames.AddRange(new string[] { "InputCore" });
	}
}
