public class CoreUObject : ModuleRules
{
	public CoreUObject(ReadOnlyTargetRules Target) : base(Target)
	{
		PublicDependencyModuleNames.AddRange(new string[] { "Core" });
	}
}
