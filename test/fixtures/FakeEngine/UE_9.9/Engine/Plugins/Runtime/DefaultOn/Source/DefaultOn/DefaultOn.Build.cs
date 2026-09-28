public class DefaultOn : ModuleRules
{
	public DefaultOn(ReadOnlyTargetRules Target) : base(Target)
	{
		PublicDependencyModuleNames.AddRange(new string[] { "Core" });
	}
}
