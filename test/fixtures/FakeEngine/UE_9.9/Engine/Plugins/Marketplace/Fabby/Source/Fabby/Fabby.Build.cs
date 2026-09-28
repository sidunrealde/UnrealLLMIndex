public class Fabby : ModuleRules
{
	public Fabby(ReadOnlyTargetRules Target) : base(Target)
	{
		PublicDependencyModuleNames.AddRange(new string[] { "Engine" });
	}
}
