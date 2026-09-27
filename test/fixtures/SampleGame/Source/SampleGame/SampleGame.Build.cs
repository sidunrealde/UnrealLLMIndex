using UnrealBuildTool;

public class SampleGame : ModuleRules
{
	public SampleGame(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

		PublicDependencyModuleNames.AddRange(
			new string[]
			{
				"Core",
				"CoreUObject",
				"Engine", // trailing comment
				// "CommentedOut",
			}
		);

		PrivateDependencyModuleNames.Add("Json");

		/* PrivateDependencyModuleNames.AddRange(new string[] { "Slate", "SlateCore" }); */
		// PrivateDependencyModuleNames.Add("OnlineSubsystem");
	}
}
